import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import os, { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  RemoteCommand,
  RemoteCommandResult,
  RemoteScreen,
  RemoteSnapshot,
  RemoteStatus,
} from "../../../src/types/remote";
import { MAX_PIN_FAILURES } from "./remote-auth";
import {
  MAX_AUDIO_BYTES,
  RemoteServer,
  lanAddresses,
  parseRemoteCommand,
  type RemoteHost,
} from "./remote-server";

const cleanup: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

// ---------------------------------------------------------------- fakes

class FakeHost implements RemoteHost {
  snapshot: RemoteSnapshot | null = null;
  readonly screens = new Map<string, RemoteScreen>();
  readonly watched: string[][] = [];
  readonly commands: RemoteCommand[] = [];
  readonly transcribed: Array<{ bytes: Uint8Array; mimeType: string }> = [];
  commandResult: RemoteCommandResult | Error = { ok: true };
  transcribeResult: string | Error = "olá mundo";
  private readonly snapshotListeners = new Set<(snapshot: RemoteSnapshot) => void>();
  private readonly screenListeners = new Set<(screen: RemoteScreen) => void>();

  getSnapshot() {
    return this.snapshot;
  }
  onSnapshot(listener: (snapshot: RemoteSnapshot) => void) {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }
  getScreen(paneId: string) {
    return this.screens.get(paneId) ?? null;
  }
  onScreen(listener: (screen: RemoteScreen) => void) {
    this.screenListeners.add(listener);
    return () => this.screenListeners.delete(listener);
  }
  setWatchedPanes(paneIds: readonly string[]) {
    this.watched.push([...paneIds]);
  }
  async runCommand(command: RemoteCommand) {
    this.commands.push(command);
    if (this.commandResult instanceof Error) throw this.commandResult;
    return this.commandResult;
  }
  async transcribe(bytes: Uint8Array, mimeType: string) {
    this.transcribed.push({ bytes, mimeType });
    if (this.transcribeResult instanceof Error) throw this.transcribeResult;
    return this.transcribeResult;
  }

  publishSnapshot(snapshot: RemoteSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.snapshotListeners) listener(snapshot);
  }
  publishScreen(screen: RemoteScreen) {
    this.screens.set(screen.paneId, screen);
    for (const listener of this.screenListeners) listener(screen);
  }
  get listenerCount() {
    return this.snapshotListeners.size + this.screenListeners.size;
  }
}

function snapshot(updatedAt: number): RemoteSnapshot {
  return {
    updatedAt,
    sessions: [
      {
        sessionId: "s1",
        title: "head-terminal",
        cwd: "C:/Users/me/head-terminal",
        agentProfileId: "claude",
        agentLabel: "Claude Code",
        active: true,
        pinned: false,
        state: "live",
        panes: [
          {
            paneId: "pane-a",
            index: 1,
            title: "Claude",
            agentProfileId: "claude",
            activity: "waiting_input",
            blockedReason: "approval",
            blockedDetail: "Bash",
            done: false,
            activitySince: updatedAt - 60_000,
          },
        ],
      },
    ],
  };
}

function screen(paneId: string, text: string, at = Date.now()): RemoteScreen {
  return {
    paneId,
    cols: 80,
    rows: 24,
    lines: [[[text, 0]]],
    styles: [""],
    theme: { background: "#0b0c0e", foreground: "#e6e7ea" },
    at,
  };
}

// ---------------------------------------------------------------- harness

async function makeUserData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ht-remote-server-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface Started {
  server: RemoteServer;
  host: FakeHost;
  userDataPath: string;
  port: number;
  ca: string;
  logs: Array<{ event: string; meta?: Record<string, unknown> }>;
  statuses: RemoteStatus[];
}

async function startServer(
  options: {
    userDataPath?: string;
    host?: FakeHost;
    preferredPort?: number;
    allowAddress?: (address: string | undefined) => boolean;
    networkInterfaces?: typeof os.networkInterfaces;
  } = {},
): Promise<Started> {
  const userDataPath = options.userDataPath ?? (await makeUserData());
  const host = options.host ?? new FakeHost();
  const logs: Started["logs"] = [];
  const server = new RemoteServer({
    host,
    userDataPath,
    bindAddress: "127.0.0.1",
    preferredPort: options.preferredPort ?? 0,
    allowAddress: options.allowAddress,
    networkInterfaces: options.networkInterfaces ?? (() => ({})),
    log: (event, meta) => logs.push({ event, meta }),
  });
  cleanup.push(() => server.close());
  const statuses: RemoteStatus[] = [];
  server.onStatus((status) => statuses.push(status));
  await server.init();
  const status = await server.setEnabled(true);
  if (!status.running || status.port === null) throw new Error(`not running: ${status.error}`);
  const tls = JSON.parse(await readFile(join(userDataPath, "remote", "tls.json"), "utf8"));
  return { server, host, userDataPath, port: status.port, ca: tls.certPem, logs, statuses };
}

interface Reply {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
  json: () => any;
}

interface CallOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  cookie?: string;
  /** Adds the X-HT-Remote header POSTs need. Default true. */
  remoteHeader?: boolean;
}

function call(started: Started, options: CallOptions = {}): Promise<Reply> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { ...options.headers };
  if (method === "POST" && options.remoteHeader !== false) headers["X-HT-Remote"] = "1";
  if (options.cookie) headers.Cookie = options.cookie;
  if (typeof options.body === "string" && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port: started.port,
        path: options.path ?? "/",
        method,
        headers,
        ca: started.ca,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const post = (started: Started, path: string, body: unknown, options: CallOptions = {}) =>
  call(started, { ...options, method: "POST", path, body: JSON.stringify(body) });

async function pair(started: Started, name = "Pixel 8"): Promise<{ cookie: string; deviceId: string }> {
  const pin = started.server.status().pin;
  const reply = await post(started, "/api/pair", { pin, name });
  expect(reply.status).toBe(200);
  const setCookie = reply.headers["set-cookie"]?.[0] ?? "";
  return { cookie: setCookie.split(";")[0], deviceId: reply.json().device.id };
}

interface SseEvent {
  event: string;
  data: string;
}

/** An open /api/events stream with its parsed events. */
function openEvents(started: Started, cookie: string, pane?: string) {
  const events: SseEvent[] = [];
  const waiters: Array<() => void> = [];
  let ended = false;
  let raw = "";
  let response: IncomingMessage | null = null;
  const req = httpsRequest({
    host: "127.0.0.1",
    port: started.port,
    path: `/api/events${pane ? `?pane=${encodeURIComponent(pane)}` : ""}`,
    headers: { Cookie: cookie },
    ca: started.ca,
    agent: false,
  });
  const opened = new Promise<IncomingMessage>((resolve, reject) => {
    req.on("response", (res) => {
      response = res;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        raw += chunk;
        let index: number;
        while ((index = raw.indexOf("\n\n")) !== -1) {
          const block = raw.slice(0, index);
          raw = raw.slice(index + 2);
          let event = "message";
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data.push(line.slice(6));
            else if (line.startsWith(":")) event = "comment";
          }
          if (data.length || event !== "message") events.push({ event, data: data.join("\n") });
        }
        for (const wake of waiters.splice(0)) wake();
      });
      res.on("end", () => {
        ended = true;
        for (const wake of waiters.splice(0)) wake();
      });
      resolve(res);
    });
    req.on("error", reject);
  });
  req.end();
  const stream = {
    events,
    opened,
    get ended() {
      return ended;
    },
    get response() {
      return response;
    },
    async waitFor(predicate: (events: SseEvent[]) => boolean, timeoutMs = 3_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(events)) {
        if (Date.now() > deadline) throw new Error(`timed out; got ${events.map((e) => e.event).join(",")}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    },
    of(event: string) {
      return events.filter((entry) => entry.event === event).map((entry) => JSON.parse(entry.data));
    },
    close() {
      req.destroy();
    },
  };
  cleanup.push(() => stream.close());
  return stream;
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await tick(20);
  }
}

// ---------------------------------------------------------------- pure helpers

describe("lanAddresses", () => {
  it("puts home networks first and virtual adapters last, without link-local", () => {
    const entry = (address: string, internal = false) =>
      ({ address, family: "IPv4", internal, netmask: "", mac: "", cidr: null }) as os.NetworkInterfaceInfo;
    const list = lanAddresses({
      "vEthernet (WSL (Hyper-V firewall))": [entry("172.29.144.1")],
      Tailscale: [entry("100.101.102.103")],
      "Wi-Fi": [entry("169.254.169.88")],
      Ethernet: [
        entry("10.0.0.5"),
        { ...entry("fe80::1"), family: "IPv6" } as os.NetworkInterfaceInfo,
      ],
      "Wi-Fi 2": [entry("192.168.16.148")],
      "Loopback Pseudo-Interface 1": [entry("127.0.0.1", true)],
      docker0: [entry("172.17.0.1")],
      Corp: [entry("172.20.1.9")],
    });
    expect(list.map((item) => item.address)).toEqual([
      "192.168.16.148",
      "10.0.0.5",
      "172.20.1.9",
      "100.101.102.103",
      "172.17.0.1",
      "172.29.144.1",
    ]);
    expect(list.filter((item) => item.virtual).map((item) => item.address)).toEqual(["172.17.0.1", "172.29.144.1"]);
  });
});

describe("parseRemoteCommand", () => {
  it("accepts each command and drops unknown fields", () => {
    expect(parseRemoteCommand({ type: "send-text", paneId: "p-1", text: "oi\nlinha", submit: true, extra: 1 })).toEqual({
      ok: true,
      command: { type: "send-text", paneId: "p-1", text: "oi\nlinha", submit: true },
    });
    expect(parseRemoteCommand({ type: "send-key", paneId: "p:1", key: "ctrl-c" })).toMatchObject({ ok: true });
    expect(parseRemoteCommand({ type: "wake-session", sessionId: "s.1" })).toMatchObject({ ok: true });
    expect(parseRemoteCommand({ type: "hibernate-session", sessionId: "s_1" })).toMatchObject({ ok: true });
    expect(parseRemoteCommand({ type: "focus-session", sessionId: "s1" })).toEqual({
      ok: true,
      command: { type: "focus-session", sessionId: "s1" },
    });
    expect(parseRemoteCommand({ type: "focus-session", sessionId: "s1", paneId: "p1" })).toEqual({
      ok: true,
      command: { type: "focus-session", sessionId: "s1", paneId: "p1" },
    });
  });

  it.each([
    [null, "invalid_command"],
    [[], "invalid_command"],
    [{ type: "rm-rf" }, "unknown_command"],
    [{ type: "send-text", paneId: "", text: "x", submit: true }, "invalid_pane_id"],
    [{ type: "send-text", paneId: "-x", text: "x", submit: true }, "invalid_pane_id"],
    [{ type: "send-text", paneId: "a".repeat(129), text: "x", submit: true }, "invalid_pane_id"],
    [{ type: "send-text", paneId: "a/b", text: "x", submit: true }, "invalid_pane_id"],
    [{ type: "send-text", paneId: "p", text: 3, submit: true }, "invalid_text"],
    [{ type: "send-text", paneId: "p", text: "a\u0000b", submit: true }, "invalid_text"],
    [{ type: "send-text", paneId: "p", text: "a\u001b[201~b", submit: true }, "invalid_text"],
    [{ type: "send-text", paneId: "p", text: "x".repeat(8001), submit: true }, "text_too_long"],
    [{ type: "send-text", paneId: "p", text: "x", submit: "yes" }, "invalid_submit"],
    [{ type: "send-key", paneId: "p", key: "f12" }, "invalid_key"],
    [{ type: "wake-session", sessionId: 1 }, "invalid_session_id"],
    [{ type: "focus-session", sessionId: "s", paneId: 2 }, "invalid_pane_id"],
  ])("refuses %j", (input, error) => {
    expect(parseRemoteCommand(input)).toEqual({ ok: false, error });
  });

  it("allows tabs, newlines and 8000 characters", () => {
    expect(parseRemoteCommand({ type: "send-text", paneId: "p", text: `a\tb\r\n${"x".repeat(7994)}`, submit: false }))
      .toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------- server

describe("RemoteServer", () => {
  it("serves the page and its files with the security headers", async () => {
    const started = await startServer();
    for (const [path, type] of [
      ["/", "text/html"],
      ["/app.js", "text/javascript"],
      ["/app.css", "text/css"],
      ["/manifest.webmanifest", "application/manifest+json"],
      ["/icon.svg", "image/svg+xml"],
    ]) {
      const reply = await call(started, { path });
      expect(reply.status, path).toBe(200);
      expect(reply.headers["content-type"]).toContain(type);
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.headers["x-content-type-options"]).toBe("nosniff");
      expect(reply.headers["referrer-policy"]).toBe("no-referrer");
      expect(reply.headers["x-frame-options"]).toBe("DENY");
      expect(reply.headers["content-security-policy"]).toBe(
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      // Vitest stubs every `*.css` import, `?raw` included, to "" unless its
      // `css.include` lists the file; the Vite build serves the real text.
      if (path !== "/app.css") expect(reply.body.length, path).toBeGreaterThan(0);
    }
    const html = (await call(started, { path: "/" })).body;
    expect(html).toContain('src="/app.js"');
    expect(html).not.toMatch(/<script>[^<]/u);
    expect(html).not.toMatch(/\sstyle=/u);
    expect(JSON.parse((await call(started, { path: "/manifest.webmanifest" })).body)).toMatchObject({
      display: "standalone",
      theme_color: "#0b0c0e",
      background_color: "#0b0c0e",
      name: "Head Terminal",
    });
    expect((await call(started, { path: "/nope" })).status).toBe(404);
    expect((await call(started, { path: "/api/nope" })).status).toBe(404);
    expect((await call(started, { path: "/", method: "POST" })).status).toBe(405);
  });

  it("reports how to reach it", async () => {
    const started = await startServer();
    const status = started.server.status();
    expect(status).toMatchObject({
      enabled: true,
      running: true,
      port: started.port,
      urls: [`https://127.0.0.1:${started.port}/`],
      devices: [],
    });
    expect(status.pin).toMatch(/^\d{6}$/u);
    expect(started.logs.some((entry) => entry.event === "remote.started")).toBe(true);
    const cert = new X509Certificate(started.ca);
    expect(cert.checkIP("127.0.0.1")).toBe("127.0.0.1");
  });

  it("pairs a phone, rotates the PIN and recognizes the cookie", async () => {
    const started = await startServer();
    expect((await call(started, { path: "/api/me" })).status).toBe(401);

    const firstPin = started.server.status().pin!;
    const wrong = await post(started, "/api/pair", { pin: firstPin === "000000" ? "000001" : "000000", name: "x" });
    expect(wrong.status).toBe(401);
    expect(wrong.json()).toEqual({ error: "invalid_pin" });

    const statusesBefore = started.statuses.length;
    const reply = await post(started, "/api/pair", { pin: firstPin, name: "Pixel 8 · Chrome" });
    expect(reply.status).toBe(200);
    expect(reply.json()).toEqual({ device: { id: expect.any(String), name: "Pixel 8 · Chrome" } });
    const setCookie = reply.headers["set-cookie"]?.[0] ?? "";
    expect(setCookie).toMatch(/^ht_remote=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=31536000$/u);
    const cookie = setCookie.split(";")[0];

    const status = started.server.status();
    expect(status.pin).not.toBe(firstPin);
    expect(status.devices).toEqual([expect.objectContaining({ name: "Pixel 8 · Chrome" })]);
    expect(started.statuses.length).toBeGreaterThan(statusesBefore);
    expect(started.statuses.at(-1)?.devices).toHaveLength(1);
    expect(started.logs.some((entry) => entry.event === "remote.paired")).toBe(true);

    // The old PIN is spent.
    expect((await post(started, "/api/pair", { pin: firstPin, name: "y" })).status).toBe(401);

    const me = await call(started, { path: "/api/me", cookie });
    expect(me.status).toBe(200);
    expect(me.json()).toEqual({ device: { id: reply.json().device.id, name: "Pixel 8 · Chrome" } });

    const stale = await call(started, { path: "/api/me", cookie: `ht_remote=${"a".repeat(43)}` });
    expect(stale.status).toBe(401);
    expect(stale.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
  });

  it("locks pairing after too many wrong PINs", async () => {
    const started = await startServer();
    const wrongPin = () => (started.server.status().pin === "000000" ? "000001" : "000000");
    for (let index = 0; index < MAX_PIN_FAILURES - 1; index += 1) {
      expect((await post(started, "/api/pair", { pin: wrongPin(), name: "x" })).status).toBe(401);
    }
    const locked = await post(started, "/api/pair", { pin: wrongPin(), name: "x" });
    expect(locked.status).toBe(429);
    expect(locked.json()).toMatchObject({ error: "locked", retryAfterMs: 600_000 });
    expect(locked.headers["retry-after"]).toBe("600");
    // Locked even for the right PIN…
    expect((await post(started, "/api/pair", { pin: started.server.status().pin, name: "x" })).status).toBe(429);
  });

  it("refuses POSTs without the remote header or from another origin", async () => {
    const started = await startServer();
    const pin = started.server.status().pin;
    const noHeader = await post(started, "/api/pair", { pin, name: "x" }, { remoteHeader: false });
    expect(noHeader.status).toBe(403);
    const otherOrigin = await post(started, "/api/pair", { pin, name: "x" }, { headers: { Origin: "https://evil.example" } });
    expect(otherOrigin.status).toBe(403);
    const nullOrigin = await post(started, "/api/pair", { pin, name: "x" }, { headers: { Origin: "null" } });
    expect(nullOrigin.status).toBe(403);
    // Nothing above counted as a guess, and the PIN is unchanged.
    expect(started.server.status().pin).toBe(pin);

    const sameOrigin = await post(
      started,
      "/api/pair",
      { pin, name: "x" },
      { headers: { Origin: `https://127.0.0.1:${started.port}` } },
    );
    expect(sameOrigin.status).toBe(200);
    const cookie = (sameOrigin.headers["set-cookie"]?.[0] ?? "").split(";")[0];
    const crossRead = await call(started, { path: "/api/me", cookie, headers: { Origin: "https://evil.example" } });
    expect(crossRead.status).toBe(403);
    const wrongType = await call(started, {
      method: "POST",
      path: "/api/command",
      cookie,
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ type: "send-key", paneId: "p", key: "enter" }),
    });
    expect(wrongType.status).toBe(415);
  });

  it("requires a paired device for every API but pairing", async () => {
    const started = await startServer();
    expect((await call(started, { path: "/api/events" })).status).toBe(401);
    expect((await post(started, "/api/command", { type: "send-key", paneId: "p", key: "enter" })).status).toBe(401);
    expect((await post(started, "/api/logout", {})).status).toBe(401);
    expect(
      (
        await call(started, {
          method: "POST",
          path: "/api/transcribe",
          headers: { "Content-Type": "audio/webm" },
          body: Buffer.from([1, 2, 3]),
        })
      ).status,
    ).toBe(401);
    expect(started.host.commands).toEqual([]);
  });

  it("validates commands and relays them to the host", async () => {
    const started = await startServer();
    const { cookie } = await pair(started);

    const ok = await post(started, "/api/command", { type: "send-text", paneId: "pane-a", text: "oi", submit: true, junk: 1 }, { cookie });
    expect(ok.status).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(started.host.commands).toEqual([{ type: "send-text", paneId: "pane-a", text: "oi", submit: true }]);

    const bad = await post(started, "/api/command", { type: "send-key", paneId: "pane-a", key: "f13" }, { cookie });
    expect(bad.status).toBe(400);
    expect(bad.json()).toEqual({ ok: false, error: "invalid_key" });

    const notJson = await call(started, { method: "POST", path: "/api/command", cookie, body: "{nope" });
    expect(notJson.status).toBe(400);

    const huge = await post(started, "/api/command", { type: "send-text", paneId: "p", text: "x".repeat(70_000), submit: false }, { cookie });
    expect(huge.status).toBe(413);

    started.host.commandResult = { ok: false, error: "session not live" };
    const refused = await post(started, "/api/command", { type: "wake-session", sessionId: "s1" }, { cookie });
    expect(refused.status).toBe(409);
    expect(refused.json()).toEqual({ ok: false, error: "session not live" });

    started.host.commandResult = new Error("boom");
    const broken = await post(started, "/api/command", { type: "focus-session", sessionId: "s1" }, { cookie });
    expect(broken.status).toBe(500);
    expect(started.host.commands).toHaveLength(3);
  });

  it("hands recorded audio to the host for transcription", async () => {
    const started = await startServer();
    const { cookie } = await pair(started);
    const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
    const reply = await call(started, {
      method: "POST",
      path: "/api/transcribe",
      cookie,
      headers: { "Content-Type": "audio/webm;codecs=opus" },
      body: audio,
    });
    expect(reply.status).toBe(200);
    expect(reply.json()).toEqual({ text: "olá mundo" });
    expect(started.host.transcribed).toHaveLength(1);
    expect(started.host.transcribed[0].mimeType).toBe("audio/webm");
    expect(Buffer.from(started.host.transcribed[0].bytes)).toEqual(audio);

    const iphone = await call(started, {
      method: "POST",
      path: "/api/transcribe",
      cookie,
      headers: { "Content-Type": "audio/mp4" },
      body: audio,
    });
    expect(iphone.status).toBe(200);
    expect(started.host.transcribed[1].mimeType).toBe("audio/mp4");

    const video = await call(started, {
      method: "POST",
      path: "/api/transcribe",
      cookie,
      headers: { "Content-Type": "video/webm" },
      body: audio,
    });
    expect(video.status).toBe(415);

    const empty = await call(started, {
      method: "POST",
      path: "/api/transcribe",
      cookie,
      headers: { "Content-Type": "audio/ogg" },
      body: Buffer.alloc(0),
    });
    expect(empty.status).toBe(400);

    started.host.transcribeResult = new Error("sem chave da OpenAI");
    const failed = await call(started, {
      method: "POST",
      path: "/api/transcribe",
      cookie,
      headers: { "Content-Type": "audio/wav" },
      body: audio,
    });
    expect(failed.status).toBe(502);
    expect(failed.json()).toEqual({ error: "sem chave da OpenAI" });
  });

  it("refuses audio bigger than the limit from its declared length", async () => {
    const started = await startServer();
    const { cookie } = await pair(started);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpsRequest({
        host: "127.0.0.1",
        port: started.port,
        path: "/api/transcribe",
        method: "POST",
        headers: {
          Cookie: cookie,
          "X-HT-Remote": "1",
          "Content-Type": "audio/webm",
          "Content-Length": String(MAX_AUDIO_BYTES + 1),
        },
        ca: started.ca,
        agent: false,
      });
      req.on("response", (res) => {
        resolve(res.statusCode ?? 0);
        req.destroy();
      });
      req.on("error", reject);
      req.flushHeaders();
    });
    expect(status).toBe(413);
  });

  it("streams state to every phone and screens only to the phone watching that pane", async () => {
    const started = await startServer();
    started.host.snapshot = snapshot(1);
    started.host.screens.set("pane-a", screen("pane-a", "first"));
    const { cookie } = await pair(started);

    const list = openEvents(started, cookie);
    const res = await list.opened;
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    await list.waitFor((events) => events.some((event) => event.event === "state"));
    expect(list.of("state")[0].updatedAt).toBe(1);
    await waitUntil(() => started.host.watched.length === 0 || started.host.watched.at(-1)!.length === 0);

    const paneA = openEvents(started, cookie, "pane-a");
    await paneA.waitFor((events) => events.some((event) => event.event === "screen"));
    expect(paneA.of("state")).toHaveLength(1);
    expect(paneA.of("screen")[0].lines[0][0][0]).toBe("first");
    await waitUntil(() => started.host.watched.at(-1)?.join() === "pane-a");

    const paneB = openEvents(started, cookie, "pane-b");
    await paneB.waitFor((events) => events.some((event) => event.event === "state"));
    expect(paneB.of("screen")).toHaveLength(0); // no screen for it yet
    await waitUntil(() => started.host.watched.at(-1)?.join() === "pane-a,pane-b");

    started.host.publishSnapshot(snapshot(2));
    started.host.publishScreen(screen("pane-a", "second"));
    started.host.publishScreen(screen("pane-b", "bee"));
    await paneA.waitFor((events) => events.filter((event) => event.event === "screen").length === 2);
    await paneB.waitFor((events) => events.some((event) => event.event === "screen"));
    await list.waitFor((events) => events.filter((event) => event.event === "state").length === 2);

    expect(paneA.of("screen").map((entry) => entry.lines[0][0][0])).toEqual(["first", "second"]);
    expect(paneB.of("screen").map((entry) => entry.lines[0][0][0])).toEqual(["bee"]);
    expect(list.of("screen")).toEqual([]);
    expect(paneA.of("state").map((entry) => entry.updatedAt)).toEqual([1, 2]);

    paneA.close();
    await waitUntil(() => started.host.watched.at(-1)?.join() === "pane-b");
    paneB.close();
    await waitUntil(() => started.host.watched.at(-1)?.length === 0);

    expect((await call(started, { path: "/api/events?pane=bad/id", cookie })).status).toBe(400);
  });

  it("sends only the newest screen to a phone that cannot keep up", async () => {
    const started = await startServer();
    const { cookie } = await pair(started);
    const stream = openEvents(started, cookie, "pane-a");
    const res = await stream.opened;
    await tick(50);
    res.pause();
    const big = "x".repeat(256 * 1024);
    const total = 60;
    for (let index = 0; index < total; index += 1) {
      started.host.publishScreen(screen("pane-a", `${index}:${big}`));
      await tick(2);
    }
    res.resume();
    await stream.waitFor(
      (events) => events.some((event) => event.event === "screen" && event.data.includes(`"${total - 1}:`)),
      10_000,
    );
    const received = stream.of("screen").map((entry) => Number(String(entry.lines[0][0][0]).split(":")[0]));
    expect(received.at(-1)).toBe(total - 1);
    expect(received.length).toBeLessThan(total);
    // In order, nothing repeated.
    expect([...received].sort((a, b) => a - b)).toEqual(received);
    expect(new Set(received).size).toBe(received.length);
  }, 20_000);

  it("ends the stream of a device when it is revoked", async () => {
    const started = await startServer();
    const { cookie, deviceId } = await pair(started);
    const other = await pair(started, "iPad");
    const stream = openEvents(started, cookie, "pane-a");
    const otherStream = openEvents(started, other.cookie);
    await stream.opened;
    await otherStream.opened;
    await waitUntil(() => started.host.watched.at(-1)?.join() === "pane-a");

    const status = await started.server.revokeDevice(deviceId);
    expect(status.devices.map((device) => device.name)).toEqual(["iPad"]);
    await stream.waitFor(() => stream.ended);
    expect(stream.events.some((event) => event.event === "bye")).toBe(true);
    await waitUntil(() => started.host.watched.at(-1)?.length === 0);
    expect(otherStream.ended).toBe(false);
    expect((await call(started, { path: "/api/me", cookie })).status).toBe(401);
    expect((await call(started, { path: "/api/me", cookie: other.cookie })).status).toBe(200);

    await started.server.revokeAllDevices();
    await otherStream.waitFor(() => otherStream.ended);
    expect(started.server.status().devices).toEqual([]);
  });

  it("logs a phone out by revoking it", async () => {
    const started = await startServer();
    const { cookie } = await pair(started);
    const stream = openEvents(started, cookie);
    await stream.opened;
    const reply = await post(started, "/api/logout", {}, { cookie });
    expect(reply.status).toBe(200);
    expect(reply.headers["set-cookie"]?.[0]).toMatch(/^ht_remote=;.*Max-Age=0/u);
    await stream.waitFor(() => stream.ended);
    expect(started.server.status().devices).toEqual([]);
    expect((await call(started, { path: "/api/me", cookie })).status).toBe(401);
  });

  it("redirects plain HTTP on the same port to HTTPS", async () => {
    const started = await startServer();
    const reply = await new Promise<{ status: number; location?: string }>((resolve, reject) => {
      httpRequest({ host: "127.0.0.1", port: started.port, path: "/some/where", agent: false }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, location: res.headers.location });
      })
        .on("error", reject)
        .end();
    });
    expect(reply).toEqual({ status: 301, location: `https://127.0.0.1:${started.port}/` });
    // HTTPS still works after the plain request.
    expect((await call(started, { path: "/" })).status).toBe(200);
  });

  it("answers 403 to addresses outside the LAN", async () => {
    const started = await startServer({ allowAddress: () => false });
    const reply = await call(started, { path: "/" });
    expect(reply.status).toBe(403);
    const plain = await new Promise<number>((resolve, reject) => {
      httpRequest({ host: "127.0.0.1", port: started.port, path: "/", agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on("error", reject)
        .end();
    });
    expect(plain).toBe(403);
    expect(started.logs.filter((entry) => entry.event === "remote.rejected_address")).toHaveLength(1);
  });

  it("moves to the next port when the preferred one is taken and remembers it", async () => {
    const blocker: NetServer = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => blocker.close(resolve)));
    const taken = (blocker.address() as { port: number }).port;
    const started = await startServer({ preferredPort: taken });
    expect(started.port).toBeGreaterThan(taken);
    expect(started.port).toBeLessThanOrEqual(taken + 10);
    const config = JSON.parse(await readFile(join(started.userDataPath, "remote", "config.json"), "utf8"));
    expect(config).toEqual({ enabled: true, port: started.port });
    expect(started.logs.some((entry) => entry.event === "remote.port_fallback")).toBe(true);
  });

  it("starts by itself when enabled, keeps the certificate and stops cleanly", async () => {
    const userDataPath = await makeUserData();
    const first = await startServer({ userDataPath });
    const { cookie } = await pair(first);
    const stream = openEvents(first, cookie);
    await stream.opened;
    // close() with an open stream still resolves, and leaves `enabled` alone.
    await first.server.close();
    await stream.waitFor(() => stream.ended);
    expect(first.server.status()).toMatchObject({ enabled: true, running: false, port: null, pin: null, urls: [] });
    expect(first.host.listenerCount).toBe(0);

    const host = new FakeHost();
    const again = new RemoteServer({
      host,
      userDataPath,
      bindAddress: "127.0.0.1",
      networkInterfaces: () => ({}),
    });
    cleanup.push(() => again.close());
    await again.init();
    const status = again.status();
    expect(status.running).toBe(true);
    expect(status.port).toBe(first.port);
    expect(status.devices).toHaveLength(1);
    const tls = JSON.parse(await readFile(join(userDataPath, "remote", "tls.json"), "utf8"));
    expect(tls.certPem).toBe(first.ca);

    const off = await again.setEnabled(false);
    expect(off).toMatchObject({ enabled: false, running: false, port: null, pin: null });
    const config = JSON.parse(await readFile(join(userDataPath, "remote", "config.json"), "utf8"));
    expect(config.enabled).toBe(false);
  });

  it("puts every LAN address in the certificate and renews it when a new one shows up", async () => {
    const userDataPath = await makeUserData();
    let interfaces: ReturnType<typeof os.networkInterfaces> = {
      "Wi-Fi": [{ address: "192.168.50.7", family: "IPv4", internal: false, netmask: "", mac: "", cidr: null }],
      "vEthernet (WSL)": [{ address: "172.29.144.1", family: "IPv4", internal: false, netmask: "", mac: "", cidr: null }],
    };
    const first = await startServer({ userDataPath, networkInterfaces: () => interfaces });
    const cert = new X509Certificate(first.ca);
    expect(cert.checkIP("192.168.50.7")).toBeDefined();
    expect(cert.checkIP("172.29.144.1")).toBeDefined();
    await first.server.close();

    // Only the virtual adapter changed: same certificate.
    interfaces = {
      ...interfaces,
      "vEthernet (WSL)": [{ address: "172.30.0.1", family: "IPv4", internal: false, netmask: "", mac: "", cidr: null }],
    };
    const second = await startServer({ userDataPath, networkInterfaces: () => interfaces });
    expect(second.ca).toBe(first.ca);
    await second.server.close();

    // A new real network: new certificate, which still knows the old one.
    interfaces = {
      Ethernet: [{ address: "10.1.2.3", family: "IPv4", internal: false, netmask: "", mac: "", cidr: null }],
    };
    const third = await startServer({ userDataPath, networkInterfaces: () => interfaces });
    expect(third.ca).not.toBe(first.ca);
    const renewed = new X509Certificate(third.ca);
    expect(renewed.checkIP("10.1.2.3")).toBeDefined();
    expect(renewed.checkIP("192.168.50.7")).toBeDefined();
    expect(third.logs.some((entry) => entry.event === "remote.cert_generated")).toBe(true);
  });

  it("replaces a certificate close to expiring", async () => {
    const userDataPath = await makeUserData();
    const first = await startServer({ userDataPath });
    await first.server.close();
    const tlsPath = join(userDataPath, "remote", "tls.json");
    const { generateSelfSignedCert } = await import("./self-signed-cert");
    const old = generateSelfSignedCert({ dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"], validityDays: 10 });
    await writeFile(tlsPath, JSON.stringify(old), "utf8");
    const second = await startServer({ userDataPath });
    expect(second.ca).not.toBe(old.certPem);
    expect(Date.parse(new X509Certificate(second.ca).validTo)).toBeGreaterThan(Date.now() + 300 * 86_400_000);
  });
});
