import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  REMOTE_KEYS,
  type RemoteCommand,
  type RemoteCommandResult,
  type RemoteKey,
  type RemoteScreen,
  type RemoteSnapshot,
  type RemoteStatus,
} from "../../../src/types/remote";
import { RemoteAuth, isAllowedRemoteAddress, writeFileAtomic } from "./remote-auth";
import { generateSelfSignedCert, type SelfSignedCert } from "./self-signed-cert";
import appCss from "./web/app.css?raw";
import appJs from "./web/app.js?raw";
import iconSvg from "./web/icon.svg?raw";
import indexHtml from "./web/index.html?raw";
import manifest from "./web/manifest.webmanifest?raw";

/**
 * The phone remote: a small HTTPS server on the LAN that serves a page for
 * the phone's browser and relays between it and the renderer, which owns
 * every session and terminal (see RemoteHost). The phone gets a snapshot of
 * the sessions and, for the one pane it looks at, that pane's screen, both
 * over one Server-Sent Events stream; it answers with small JSON commands.
 *
 * HTTPS because the phone only grants the microphone to a secure context;
 * the certificate is self-signed and generated here (self-signed-cert.ts).
 * The same port also answers plain HTTP, with a redirect to HTTPS, so a URL
 * typed without the scheme still lands on the page.
 *
 * Only LAN and loopback addresses are answered at all; everything under
 * /api except pairing needs the cookie a pairing hands out (remote-auth.ts),
 * and every POST must carry `X-HT-Remote: 1` and a same-origin Origin.
 */

export interface RemoteHost {
  getSnapshot(): RemoteSnapshot | null;
  onSnapshot(listener: (snapshot: RemoteSnapshot) => void): () => void;
  getScreen(paneId: string): RemoteScreen | null;
  onScreen(listener: (screen: RemoteScreen) => void): () => void;
  /** União dos panes que algum celular está olhando agora; chame sempre que mudar. */
  setWatchedPanes(paneIds: readonly string[]): void;
  runCommand(command: RemoteCommand): Promise<RemoteCommandResult>;
  transcribe(bytes: Uint8Array, mimeType: string): Promise<string>;
}

export interface RemoteServerOptions {
  host: RemoteHost;
  /** Uses <userData>/remote/: tls.json (key+cert), devices.json, config.json {enabled, port}. */
  userDataPath: string;
  log?: (event: string, meta?: Record<string, unknown>) => void;
  now?: () => number;
  /** Injectable for tests. */
  networkInterfaces?: typeof os.networkInterfaces;
  /** Default "0.0.0.0"; tests use "127.0.0.1". */
  bindAddress?: string;
  /** Default 47820. When taken, the next ones are tried and the one that
   * worked is kept in config.json. */
  preferredPort?: number;
  /** Tests only: which peer addresses are answered. Defaults to
   * isAllowedRemoteAddress. */
  allowAddress?: (address: string | undefined) => boolean;
}

export const DEFAULT_REMOTE_PORT = 47820;
/** The preferred port and the ten after it. */
const PORT_ATTEMPTS = 11;
const COOKIE_NAME = "ht_remote";
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
export const MAX_JSON_BODY_BYTES = 64 * 1024;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 8000;
export const SSE_KEEPALIVE_MS = 15_000;
const NETWORK_CHECK_MS = 30_000;
const CERT_MIN_REMAINING_MS = 30 * 24 * 60 * 60_000;
/** Addresses kept in the certificate, so moving between networks does not
 * mint a new one (and a new browser warning) each time. */
const MAX_CERT_IPS = 24;
/** How long a new connection may stay silent before its first byte. */
const FIRST_BYTE_TIMEOUT_MS = 10_000;
const MAX_PLAIN_HEAD_BYTES = 8 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
/** C0 controls but tab, LF and CR; DEL; C1 controls. ESC in particular would
 * let a pasted text break out of bracketed paste. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const AUDIO_TYPES = new Set(["audio/webm", "audio/mp4", "audio/ogg", "audio/wav"]);
const REMOTE_KEY_SET: ReadonlySet<string> = new Set(REMOTE_KEYS);
const HOST_HEADER = /^(\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9.-]{1,253})(?::\d{1,5})?$/u;
/** Adapters that are not the LAN a phone is on. */
const VIRTUAL_INTERFACE =
  /vethernet|wsl|hyper-v|virtualbox|vbox|vmware|vmnet|docker|podman|br-[0-9a-f]|veth|virbr|zerotier|npcap|loopback|bridge\d|utun/iu;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
};

const STATIC_FILES: Record<string, { body: string; type: string }> = {
  "/": { body: indexHtml, type: "text/html; charset=utf-8" },
  "/index.html": { body: indexHtml, type: "text/html; charset=utf-8" },
  "/app.js": { body: appJs, type: "text/javascript; charset=utf-8" },
  "/app.css": { body: appCss, type: "text/css; charset=utf-8" },
  "/manifest.webmanifest": { body: manifest, type: "application/manifest+json; charset=utf-8" },
  "/icon.svg": { body: iconSvg, type: "image/svg+xml; charset=utf-8" },
};

// ---------------------------------------------------------------- helpers

export interface LanAddress {
  address: string;
  interfaceName: string;
  /** Lower is likelier to be the network the phone is on. */
  rank: number;
  virtual: boolean;
}

function ipv4Octets(address: string): number[] {
  return address.split(".").map((part) => Number.parseInt(part, 10));
}

/**
 * Every non-internal IPv4 the phone could reach, best guess first: home
 * networks (192.168, 10), then the rest of the private ranges, Tailscale,
 * anything else, and last the virtual adapters of WSL, Hyper-V, Docker and
 * VMs. Link-local (169.254) addresses are left out: an adapter has one only
 * when it found no network.
 */
export function lanAddresses(interfaces: ReturnType<typeof os.networkInterfaces>): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      // Node < 18.4 reported the family as a number.
      const family = String(entry.family);
      if (entry.internal || (family !== "IPv4" && family !== "4")) continue;
      const [a, b] = ipv4Octets(entry.address);
      if (a === 169 && b === 254) continue;
      const virtual = VIRTUAL_INTERFACE.test(interfaceName);
      let rank: number;
      if (virtual) rank = 9;
      else if (a === 192 && b === 168) rank = 0;
      else if (a === 10) rank = 1;
      else if (a === 172 && b >= 16 && b <= 31) rank = 2;
      else if (a === 100 && b >= 64 && b <= 127) rank = 3;
      else rank = 4;
      if (!out.some((known) => known.address === entry.address)) {
        out.push({ address: entry.address, interfaceName, rank, virtual });
      }
    }
  }
  return out.sort(
    (left, right) =>
      left.rank - right.rank ||
      left.interfaceName.localeCompare(right.interfaceName) ||
      left.address.localeCompare(right.address, undefined, { numeric: true }),
  );
}

/** Command a phone sent, checked field by field and rebuilt without extras. */
export function parseRemoteCommand(
  value: unknown,
): { ok: true; command: RemoteCommand } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "invalid_command" };
  }
  const input = value as Record<string, unknown>;
  const isId = (id: unknown): id is string => typeof id === "string" && ID_PATTERN.test(id);
  switch (input.type) {
    case "send-text": {
      if (!isId(input.paneId)) return { ok: false, error: "invalid_pane_id" };
      if (typeof input.text !== "string") return { ok: false, error: "invalid_text" };
      if (input.text.length > MAX_TEXT_LENGTH) return { ok: false, error: "text_too_long" };
      if (FORBIDDEN_TEXT.test(input.text)) return { ok: false, error: "invalid_text" };
      if (typeof input.submit !== "boolean") return { ok: false, error: "invalid_submit" };
      return { ok: true, command: { type: "send-text", paneId: input.paneId, text: input.text, submit: input.submit } };
    }
    case "send-key": {
      if (!isId(input.paneId)) return { ok: false, error: "invalid_pane_id" };
      if (typeof input.key !== "string" || !REMOTE_KEY_SET.has(input.key)) {
        return { ok: false, error: "invalid_key" };
      }
      return { ok: true, command: { type: "send-key", paneId: input.paneId, key: input.key as RemoteKey } };
    }
    case "wake-session":
    case "hibernate-session": {
      if (!isId(input.sessionId)) return { ok: false, error: "invalid_session_id" };
      return { ok: true, command: { type: input.type, sessionId: input.sessionId } };
    }
    case "focus-session": {
      if (!isId(input.sessionId)) return { ok: false, error: "invalid_session_id" };
      if (input.paneId !== undefined && !isId(input.paneId)) return { ok: false, error: "invalid_pane_id" };
      return {
        ok: true,
        command: {
          type: "focus-session",
          sessionId: input.sessionId,
          ...(input.paneId !== undefined ? { paneId: input.paneId as string } : {}),
        },
      };
    }
    default:
      return { ok: false, error: "unknown_command" };
  }
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!cookies.has(name)) cookies.set(name, part.slice(index + 1).trim());
  }
  return cookies;
}

/** `::ffff:192.168.0.5` → `192.168.0.5`, so one phone is one address. */
function normalizeAddress(address: string | undefined): string {
  if (!address) return "";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address);
  return mapped ? mapped[1] : address;
}

function sseEvent(event: string, data: unknown): string {
  // JSON never contains a raw newline, so one data line is enough.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new HttpError(413, "body_too_large"));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new HttpError(413, "body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "expected_json");
  const body = await readBody(req, MAX_JSON_BODY_BYTES);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

// ---------------------------------------------------------------- server

interface RemoteConfig {
  enabled: boolean;
  port?: number;
}

interface EventStream {
  res: ServerResponse;
  deviceId: string;
  /** Kept to refresh lastSeenAt and notice a revocation on each ping. */
  token: string;
  paneId: string | null;
  /** `res.write` said to wait for "drain"; only the newest of each kind waits. */
  blocked: boolean;
  pendingState: string | null;
  pendingScreen: string | null;
  closed: boolean;
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

export class RemoteServer {
  private readonly host: RemoteHost;
  private readonly dir: string;
  private readonly log: (event: string, meta?: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly networkInterfaces: typeof os.networkInterfaces;
  private readonly bindAddress: string;
  private readonly preferredPort: number;
  private readonly allowAddress: (address: string | undefined) => boolean;
  private readonly auth: RemoteAuth;

  private config: RemoteConfig = { enabled: false };
  private tls: SelfSignedCert | null = null;
  private server: HttpsServer | null = null;
  private port: number | null = null;
  private lastError: string | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly streams = new Set<EventStream>();
  private watchedKey = "";
  private hostSubscriptions: Array<() => void> = [];
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private networkTimer: NodeJS.Timeout | null = null;
  private lastUrlsKey = "";
  private readonly statusListeners = new Set<(status: RemoteStatus) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly rejectedLogged = new Map<string, number>();

  constructor(options: RemoteServerOptions) {
    this.host = options.host;
    this.dir = path.join(options.userDataPath, "remote");
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.networkInterfaces = options.networkInterfaces ?? os.networkInterfaces;
    this.bindAddress = options.bindAddress ?? "0.0.0.0";
    this.preferredPort = options.preferredPort ?? DEFAULT_REMOTE_PORT;
    this.allowAddress = options.allowAddress ?? isAllowedRemoteAddress;
    this.auth = new RemoteAuth({
      devicesPath: path.join(this.dir, "devices.json"),
      now: this.now,
      log: this.log,
    });
    this.auth.onChange(() => this.emitStatus());
  }

  /** Reads config.json and starts when it says so. */
  init(): Promise<void> {
    return this.enqueue(async () => {
      await this.auth.load();
      this.config = await this.readConfig();
      if (this.config.enabled) await this.start();
      this.emitStatus();
    });
  }

  /** Persists the choice and starts or stops. */
  setEnabled(enabled: boolean): Promise<RemoteStatus> {
    return this.enqueue(async () => {
      this.config = { ...this.config, enabled };
      await this.writeConfig();
      if (enabled) await this.start();
      else await this.stop();
      this.emitStatus();
      return this.status();
    });
  }

  status(): RemoteStatus {
    const running = this.server !== null && this.port !== null;
    const status: RemoteStatus = {
      enabled: this.config.enabled,
      running,
      port: running ? this.port : null,
      urls: running ? this.urls() : [],
      pin: running ? this.auth.pin : null,
      devices: this.auth.devices(),
    };
    if (!running && this.config.enabled && this.lastError) status.error = this.lastError;
    return status;
  }

  onStatus(listener: (status: RemoteStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  regeneratePin(): RemoteStatus {
    this.auth.regeneratePin();
    return this.status();
  }

  async revokeDevice(id: string): Promise<RemoteStatus> {
    if (await this.auth.revoke(id)) this.endStreams((stream) => stream.deviceId === id);
    return this.status();
  }

  async revokeAllDevices(): Promise<RemoteStatus> {
    await this.auth.revokeAll();
    this.endStreams(() => true);
    return this.status();
  }

  /** Stops serving without touching `enabled`. */
  close(): Promise<void> {
    return this.enqueue(async () => {
      await this.stop();
      await this.auth.flush().catch(() => undefined);
    });
  }

  // -------------------------------------------------------------- lifecycle

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async start(): Promise<void> {
    if (this.server) return;
    this.lastError = undefined;
    let server: HttpsServer | null = null;
    try {
      const addresses = lanAddresses(this.networkInterfaces());
      this.tls = await this.ensureCertificate(this.tls, addresses);
      server = createHttpsServer(
        { key: this.tls.keyPem, cert: this.tls.certPem, minVersion: "TLSv1.2" },
        (req, res) => void this.handle(req, res),
      );
      this.installProtocolSniffer(server);
      server.on("secureConnection", (socket: Socket) => this.track(socket));
      server.on("tlsClientError", () => undefined);
      server.on("clientError", (_error, socket) => socket.destroy());
      const base = this.config.port ?? this.preferredPort;
      const port = await this.listen(server, base);
      // From here an 'error' (EMFILE on accept…) is logged, never thrown: an
      // unhandled one would take the whole main process down.
      server.on("error", (error) => this.log("remote.server_error", { error: String(error) }));
      this.server = server;
      this.port = port;
      if (this.config.port !== port) {
        if (port !== base) this.log("remote.port_fallback", { preferred: base, port });
        this.config = { ...this.config, port };
        await this.writeConfig().catch((error: unknown) =>
          this.log("remote.config_write_failed", { error: String(error) }),
        );
      }
      this.subscribeHost();
      this.keepaliveTimer = setInterval(() => this.keepalive(), SSE_KEEPALIVE_MS);
      this.keepaliveTimer.unref?.();
      this.networkTimer = setInterval(() => void this.checkNetwork(), NETWORK_CHECK_MS);
      this.networkTimer.unref?.();
      this.lastUrlsKey = this.urls().join(" ");
      this.log("remote.started", { port, urls: this.urls() });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log("remote.start_failed", { error: this.lastError });
      if (server && this.server !== server) server.close();
      this.server = null;
      this.port = null;
    }
  }

  private async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.port = null;
    for (const unsubscribe of this.hostSubscriptions.splice(0)) unsubscribe();
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.networkTimer) clearInterval(this.networkTimer);
    this.keepaliveTimer = null;
    this.networkTimer = null;
    for (const stream of this.streams) {
      stream.closed = true;
      stream.res.end();
    }
    this.streams.clear();
    this.updateWatchedPanes();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
    });
    this.log("remote.stopped");
  }

  private listen(server: HttpsServer, base: number): Promise<number> {
    const attempt = (index: number): Promise<number> =>
      new Promise<number>((resolve, reject) => {
        const port = base + index;
        const onError = (error: NodeJS.ErrnoException) => {
          server.off("listening", onListening);
          // Windows answers EACCES for ports Hyper-V reserved.
          const busy = error.code === "EADDRINUSE" || error.code === "EACCES";
          if (busy && index + 1 < PORT_ATTEMPTS && port < 65535) {
            resolve(attempt(index + 1));
          } else if (busy) {
            reject(new Error(`ports ${base}-${port} are all in use`));
          } else {
            reject(error);
          }
        };
        const onListening = () => {
          server.off("error", onError);
          resolve((server.address() as AddressInfo).port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, this.bindAddress);
      });
    return attempt(0);
  }

  private track(socket: Socket): void {
    if (this.sockets.has(socket)) return;
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  /**
   * One port for both schemes: a TLS ClientHello starts with 0x16, an HTTP
   * request with a method name. The first chunk is put back and the socket
   * handed to TLS, or answered with a redirect to https.
   */
  private installProtocolSniffer(server: HttpsServer): void {
    const tlsListeners = server.listeners("connection") as Array<(socket: Socket) => void>;
    server.removeAllListeners("connection");
    server.on("connection", (socket: Socket) => {
      this.track(socket);
      socket.on("error", () => socket.destroy());
      const onSilent = () => socket.destroy();
      socket.setTimeout(FIRST_BYTE_TIMEOUT_MS, onSilent);
      socket.once("data", (chunk: Buffer) => {
        socket.setTimeout(0);
        socket.off("timeout", onSilent);
        socket.pause();
        socket.unshift(chunk);
        if (chunk[0] === 0x16) {
          for (const listener of tlsListeners) listener.call(server, socket);
        } else if (chunk[0] >= 0x41 && chunk[0] <= 0x5a) {
          this.answerPlainHttp(socket);
        } else {
          socket.destroy();
        }
      });
    });
  }

  private answerPlainHttp(socket: Socket): void {
    let head = Buffer.alloc(0);
    const onSilent = () => socket.destroy();
    socket.setTimeout(FIRST_BYTE_TIMEOUT_MS, onSilent);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1 && head.length < MAX_PLAIN_HEAD_BYTES) return;
      socket.off("data", onData);
      socket.setTimeout(0);
      socket.off("timeout", onSilent);
      const text = head.subarray(0, end === -1 ? head.length : end).toString("latin1");
      if (!this.allowAddress(socket.remoteAddress)) {
        this.logRejected(socket.remoteAddress);
        socket.end(plainResponse("403 Forbidden", "Forbidden\n"));
        return;
      }
      const hostHeader = /^host:[ \t]*([^\r\n]*)$/imu.exec(text)?.[1]?.trim() ?? "";
      const hostMatch = HOST_HEADER.exec(hostHeader);
      let hostname = hostMatch?.[1];
      if (!hostname) {
        const local = normalizeAddress(socket.localAddress);
        hostname = local.includes(":") ? `[${local}]` : local || "localhost";
      }
      const location = `https://${hostname}:${this.port ?? (socket.localPort as number)}/`;
      socket.end(
        plainResponse("301 Moved Permanently", `Use ${location}\n`, { Location: location }),
      );
    };
    socket.on("data", onData);
    socket.resume();
  }

  // -------------------------------------------------------------- certificate & network

  private urls(): string[] {
    const port = this.port;
    if (port === null) return [];
    if (/^127\.|^::1$|^localhost$/u.test(this.bindAddress)) return [`https://127.0.0.1:${port}/`];
    return lanAddresses(this.networkInterfaces()).map((entry) => `https://${entry.address}:${port}/`);
  }

  private async ensureCertificate(
    current: SelfSignedCert | null,
    addresses: LanAddress[],
  ): Promise<SelfSignedCert> {
    const tlsPath = path.join(this.dir, "tls.json");
    const known = current ?? (await this.readTls(tlsPath));
    const required = addresses.filter((entry) => !entry.virtual).map((entry) => entry.address);
    if (known && this.certCovers(known, required)) return known;
    const ipAddresses = [
      ...new Set([
        "127.0.0.1",
        "::1",
        ...addresses.map((entry) => entry.address),
        ...(known?.ipAddresses ?? []),
      ]),
    ].slice(0, MAX_CERT_IPS);
    const hostname = os.hostname().toLowerCase();
    const generated = generateSelfSignedCert({
      dnsNames: ["localhost", hostname, `${hostname}.local`],
      ipAddresses,
      now: this.now(),
    });
    await writeFileAtomic(tlsPath, `${JSON.stringify(generated, null, 2)}\n`);
    this.log("remote.cert_generated", { ipAddresses: generated.ipAddresses, notAfter: generated.notAfter });
    return generated;
  }

  private async readTls(tlsPath: string): Promise<SelfSignedCert | null> {
    try {
      const parsed = JSON.parse(await readFile(tlsPath, "utf8")) as Partial<SelfSignedCert>;
      if (typeof parsed.certPem !== "string" || typeof parsed.keyPem !== "string") return null;
      const cert = new X509Certificate(parsed.certPem);
      if (!cert.checkPrivateKey(createPrivateKey(parsed.keyPem))) return null;
      return {
        certPem: parsed.certPem,
        keyPem: parsed.keyPem,
        notAfter: Date.parse(cert.validTo),
        ipAddresses: Array.isArray(parsed.ipAddresses) ? parsed.ipAddresses.filter((ip) => typeof ip === "string") : [],
        dnsNames: Array.isArray(parsed.dnsNames) ? parsed.dnsNames.filter((name) => typeof name === "string") : [],
      };
    } catch {
      return null;
    }
  }

  private certCovers(tls: SelfSignedCert, required: readonly string[]): boolean {
    try {
      const cert = new X509Certificate(tls.certPem);
      const now = this.now();
      if (Date.parse(cert.validFrom) > now) return false;
      if (Date.parse(cert.validTo) - now < CERT_MIN_REMAINING_MS) return false;
      return required.every((ip) => cert.checkIP(ip) !== undefined);
    } catch {
      return false;
    }
  }

  /** New addresses show up in Settings, and in the certificate when the
   * phone could be on them. */
  private async checkNetwork(): Promise<void> {
    const server = this.server;
    if (!server || !this.tls) return;
    const addresses = lanAddresses(this.networkInterfaces());
    try {
      const next = await this.ensureCertificate(this.tls, addresses);
      if (next !== this.tls && this.server === server) {
        this.tls = next;
        server.setSecureContext({ key: next.keyPem, cert: next.certPem, minVersion: "TLSv1.2" });
      }
    } catch (error) {
      this.log("remote.cert_refresh_failed", { error: String(error) });
    }
    const key = this.urls().join(" ");
    if (key !== this.lastUrlsKey) {
      this.lastUrlsKey = key;
      this.emitStatus();
    }
  }

  // -------------------------------------------------------------- config

  private async readConfig(): Promise<RemoteConfig> {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.dir, "config.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const port = Number(parsed.port);
      return {
        enabled: parsed.enabled === true,
        ...(Number.isInteger(port) && port > 0 && port < 65536 ? { port } : {}),
      };
    } catch {
      return { enabled: false };
    }
  }

  private writeConfig(): Promise<void> {
    return writeFileAtomic(path.join(this.dir, "config.json"), `${JSON.stringify(this.config, null, 2)}\n`);
  }

  // -------------------------------------------------------------- host relay

  private subscribeHost(): void {
    this.hostSubscriptions.push(
      this.host.onSnapshot((snapshot) => {
        if (this.streams.size === 0) return;
        const payload = sseEvent("state", snapshot);
        for (const stream of this.streams) this.send(stream, "state", payload);
      }),
      this.host.onScreen((screen) => {
        let payload: string | null = null;
        for (const stream of this.streams) {
          if (stream.paneId !== screen.paneId) continue;
          payload ??= sseEvent("screen", screen);
          this.send(stream, "screen", payload);
        }
      }),
    );
  }

  private send(stream: EventStream, kind: "state" | "screen" | "other", payload: string): void {
    if (stream.closed) return;
    if (stream.blocked) {
      // Snapshots and screens are whole, never diffs: the newest is all a
      // slow phone needs once it catches up. Pings are simply skipped.
      if (kind === "state") stream.pendingState = payload;
      else if (kind === "screen") stream.pendingScreen = payload;
      return;
    }
    if (!stream.res.write(payload)) {
      stream.blocked = true;
      stream.res.once("drain", () => {
        stream.blocked = false;
        const state = stream.pendingState;
        const screen = stream.pendingScreen;
        stream.pendingState = null;
        stream.pendingScreen = null;
        if (state) this.send(stream, "state", state);
        if (screen) this.send(stream, "screen", screen);
      });
    }
  }

  private keepalive(): void {
    for (const stream of [...this.streams]) {
      if (!this.auth.authenticate(stream.token)) {
        this.endStream(stream);
        continue;
      }
      this.send(stream, "other", ": ping\n\n");
    }
  }

  private endStream(stream: EventStream): void {
    if (stream.closed) return;
    this.send(stream, "other", sseEvent("bye", {}));
    stream.closed = true;
    stream.res.end();
    this.streams.delete(stream);
    this.updateWatchedPanes();
  }

  private endStreams(predicate: (stream: EventStream) => boolean): void {
    for (const stream of [...this.streams]) if (predicate(stream)) this.endStream(stream);
  }

  private updateWatchedPanes(): void {
    const panes = [...new Set([...this.streams].map((stream) => stream.paneId).filter((id): id is string => !!id))].sort();
    const key = panes.join("\n");
    if (key === this.watchedKey) return;
    this.watchedKey = key;
    try {
      this.host.setWatchedPanes(panes);
    } catch (error) {
      this.log("remote.host_error", { method: "setWatchedPanes", error: String(error) });
    }
  }

  private emitStatus(): void {
    if (this.statusListeners.size === 0) return;
    const status = this.status();
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  // -------------------------------------------------------------- requests

  private logRejected(address: string | undefined): void {
    const key = address ?? "";
    const now = this.now();
    if (now - (this.rejectedLogged.get(key) ?? -Infinity) < 60_000) return;
    if (this.rejectedLogged.size > 256) this.rejectedLogged.clear();
    this.rejectedLogged.set(key, now);
    this.log("remote.rejected_address", { address });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.allowAddress(req.socket.remoteAddress)) {
        this.logRejected(req.socket.remoteAddress);
        res.writeHead(403, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        res.end("Forbidden\n");
        return;
      }
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
      const url = new URL(req.url ?? "/", "https://remote.invalid");
      const method = req.method ?? "GET";

      const asset = STATIC_FILES[url.pathname];
      if (asset) {
        if (method !== "GET" && method !== "HEAD") return this.methodNotAllowed(res, "GET, HEAD");
        res.writeHead(200, { "Content-Type": asset.type, "Content-Length": Buffer.byteLength(asset.body) });
        res.end(method === "HEAD" ? undefined : asset.body);
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found\n");
        return;
      }

      const route = this.apiRoute(url.pathname);
      if (!route) return this.json(res, 404, { error: "not_found" });
      if (method !== route.method) return this.methodNotAllowed(res, route.method);
      if (!this.sameOrigin(req) || (method === "POST" && req.headers["x-ht-remote"] !== "1")) {
        this.log("remote.csrf_rejected", { path: url.pathname });
        return this.json(res, 403, { error: "forbidden" });
      }
      await route.run(req, res, url);
    } catch (error) {
      if (error instanceof HttpError) {
        if (!res.headersSent) {
          res.setHeader("Connection", "close");
          this.json(res, error.status, { error: error.code });
        } else {
          res.end();
        }
        if (error.status === 413) req.resume();
        return;
      }
      this.log("remote.request_failed", { error: String(error) });
      if (!res.headersSent) this.json(res, 500, { error: "internal" });
      else res.end();
    }
  }

  /** An Origin, when the browser sends one, must be this very server. */
  private sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    const host = req.headers.host;
    return !!host && origin.toLowerCase() === `https://${host.toLowerCase()}`;
  }

  private methodNotAllowed(res: ServerResponse, allow: string): void {
    res.setHeader("Allow", allow);
    this.json(res, 405, { error: "method_not_allowed" });
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  private token(req: IncomingMessage): string | null {
    return parseCookies(req.headers.cookie).get(COOKIE_NAME) ?? null;
  }

  /** The paired device behind the request, or a 401 already sent. */
  private requireDevice(req: IncomingMessage, res: ServerResponse) {
    const token = this.token(req);
    const device = this.auth.authenticate(token);
    if (device && token) return { device, token };
    this.json(
      res,
      401,
      { error: "unauthorized" },
      token !== null ? { "Set-Cookie": clearCookie() } : {},
    );
    return null;
  }

  private apiRoute(pathname: string): { method: "GET" | "POST"; run: Handler } | null {
    switch (pathname) {
      case "/api/me":
        return { method: "GET", run: (req, res) => this.handleMe(req, res) };
      case "/api/pair":
        return { method: "POST", run: (req, res) => this.handlePair(req, res) };
      case "/api/logout":
        return { method: "POST", run: (req, res) => this.handleLogout(req, res) };
      case "/api/events":
        return { method: "GET", run: (req, res, url) => this.handleEvents(req, res, url) };
      case "/api/command":
        return { method: "POST", run: (req, res) => this.handleCommand(req, res) };
      case "/api/transcribe":
        return { method: "POST", run: (req, res) => this.handleTranscribe(req, res) };
      default:
        return null;
    }
  }

  private handleMe(req: IncomingMessage, res: ServerResponse): void {
    const auth = this.requireDevice(req, res);
    if (!auth) return;
    this.json(res, 200, { device: { id: auth.device.id, name: auth.device.name } });
  }

  private async handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJson(req)) as Record<string, unknown> | null;
    const input = body && typeof body === "object" ? body : {};
    const address = normalizeAddress(req.socket.remoteAddress);
    const result = await this.auth.pair(input.pin, input.name, address);
    if (result.ok) {
      this.json(
        res,
        200,
        { device: { id: result.device.id, name: result.device.name } },
        {
          "Set-Cookie": `${COOKIE_NAME}=${result.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`,
        },
      );
      return;
    }
    if (result.reason === "locked") {
      this.json(
        res,
        429,
        { error: "locked", retryAfterMs: result.retryAfterMs },
        { "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)) },
      );
      return;
    }
    this.json(res, 401, { error: "invalid_pin" });
  }

  private async handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = this.requireDevice(req, res);
    if (!auth) return;
    await this.auth.revoke(auth.device.id);
    this.endStreams((stream) => stream.deviceId === auth.device.id);
    this.json(res, 200, { ok: true }, { "Set-Cookie": clearCookie() });
  }

  private handleEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const auth = this.requireDevice(req, res);
    if (!auth) return;
    const pane = url.searchParams.get("pane");
    if (pane !== null && !ID_PATTERN.test(pane)) {
      this.json(res, 400, { error: "invalid_pane_id" });
      return;
    }
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const stream: EventStream = {
      res,
      deviceId: auth.device.id,
      token: auth.token,
      paneId: pane,
      blocked: false,
      pendingState: null,
      pendingScreen: null,
      closed: false,
    };
    this.streams.add(stream);
    res.on("close", () => {
      stream.closed = true;
      if (this.streams.delete(stream)) this.updateWatchedPanes();
    });
    this.send(stream, "other", "retry: 2000\n\n");
    const snapshot = this.host.getSnapshot();
    if (snapshot) this.send(stream, "state", sseEvent("state", snapshot));
    if (pane) {
      const screen = this.host.getScreen(pane);
      if (screen) this.send(stream, "screen", sseEvent("screen", screen));
    }
    this.updateWatchedPanes();
  }

  private async handleCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = this.requireDevice(req, res);
    if (!auth) return;
    const parsed = parseRemoteCommand(await readJson(req));
    if (!parsed.ok) {
      this.json(res, 400, { ok: false, error: parsed.error });
      return;
    }
    let result: RemoteCommandResult;
    try {
      result = await this.host.runCommand(parsed.command);
    } catch (error) {
      this.log("remote.command_failed", { type: parsed.command.type, error: String(error) });
      this.json(res, 500, { ok: false, error: "internal" });
      return;
    }
    if (result.ok) this.json(res, 200, { ok: true });
    else this.json(res, 409, { ok: false, error: String(result.error).slice(0, 500) });
  }

  private async handleTranscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = this.requireDevice(req, res);
    if (!auth) return;
    const mimeType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (!AUDIO_TYPES.has(mimeType)) {
      res.setHeader("Connection", "close");
      this.json(res, 415, { error: "unsupported_audio_type" });
      return;
    }
    const bytes = await readBody(req, MAX_AUDIO_BYTES);
    if (bytes.length === 0) {
      this.json(res, 400, { error: "empty_audio" });
      return;
    }
    let text: string;
    try {
      text = await this.host.transcribe(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), mimeType);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      this.log("remote.transcribe_failed", { error: message });
      this.json(res, 502, { error: message || "transcription_failed" });
      return;
    }
    this.json(res, 200, { text: typeof text === "string" ? text : "" });
  }
}

function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function plainResponse(status: string, body: string, headers: Record<string, string> = {}): string {
  const lines = [
    `HTTP/1.1 ${status}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Cache-Control: no-store",
    "Connection: close",
  ];
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}
