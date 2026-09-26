import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { AGENT_HOOK_PANE_HEADER, AGENT_HOOK_PANE_ID } from "../../src/types/agent-hooks";
import { UNIX_USER_BIN_PATH_EXPORT } from "../../src/core/unix-cli-probe";
import type { AgentHookEventPayload, ClaudeHookSettings } from "../types/api";
import { runCommand } from "./command-runner";
import { resolvePowerShell } from "./windows-shell";

/**
 * Claude Code reports its own lifecycle through HTTP hooks: every Claude pane
 * is launched with `--settings <file>` pointing at a file of its own, written
 * here, and each hook POSTs the event to this loopback server with the pane
 * id — written literally into that file — in a header. The server answers
 * `{}` — never a decision — and forwards a trimmed copy of the event to the
 * renderer, where the pane status is derived. Without it a pane can only
 * guess from its title and screen whether Claude is waiting on the user or
 * just done.
 *
 * The pane id lives in the file, not in the pane's env, because `--settings`
 * is what travels with a session Claude moves to the background; the env of
 * a background session is the supervisor's, i.e. whichever pane started the
 * supervisor first. The port and the token outlive the app run for the same
 * sessions: a surviving worker keeps the URL it was started with, and one
 * that respawns re-reads the file.
 */

/** Hook events the status needs. `matcher` only where the event takes one;
 * SessionStart is absent because it does not accept HTTP hooks. */
export const CLAUDE_STATUS_HOOK_EVENTS: ReadonlyArray<{ event: string; matcher: boolean }> = [
  { event: "UserPromptSubmit", matcher: false },
  { event: "PermissionRequest", matcher: true },
  { event: "Notification", matcher: true },
  { event: "Elicitation", matcher: true },
  { event: "ElicitationResult", matcher: true },
  { event: "PostToolUse", matcher: true },
  { event: "PostToolUseFailure", matcher: true },
  { event: "Stop", matcher: false },
  { event: "StopFailure", matcher: true },
];

/**
 * Oldest Claude Code the hooks are handed to. HTTP hooks arrived in 2.1.63,
 * Elicitation in 2.1.76 and StopFailure in 2.1.78; until 2.1.101 an unknown
 * event name, and until 2.1.122 any malformed hook entry, invalidated the
 * whole settings file. From 2.1.122 on, anything this file says that an
 * install does not understand costs one hook, never the pane's startup.
 */
export const MIN_CLAUDE_HOOKS_VERSION = "2.1.122";

/** Seconds Claude waits for an answer. The answer is immediate; this only
 * bounds how long a wedged main process could stall a turn. */
const HOOK_TIMEOUT_SECONDS = 3;
/** PermissionRequest carries the tool input — a whole file for a Write. The
 * status needs a handful of short fields, so nothing past this is kept. */
export const MAX_HOOK_BODY_BYTES = 1024 * 1024;
/** Where the fields are looked for when the body is too big or not JSON:
 * Claude writes them before the tool input. */
const FALLBACK_SCAN_BYTES = 64 * 1024;
const HOOK_PATH_PREFIX = "/claude-hook/";
const SETTINGS_DIR = "agent-hooks";
/** One `<paneId>.json` per pane that ever started Claude with hooks. */
const PANES_DIR = "panes";
/** `{ port, token }` of the last run, so the URL survives a restart. */
const STATE_FILE = "state.json";
/**
 * A pane file no spawn has asked for in this long is removed at startup.
 * Files are never removed sooner: a background session keeps pointing at the
 * file of the pane it came from after that pane closes, and Claude refuses
 * to (re)start on a `--settings` file that is not there.
 */
export const PANE_FILE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
/** A failed or too-old probe is asked again after this long: the startup
 * installer may still be putting `claude` on the PATH, and Claude updates
 * itself while the app runs. */
const VERSION_RETRY_MS = 60_000;

const MAX_FIELD_LENGTH = 256;
const EVENT_NAME = /^[A-Za-z]{1,64}$/u;
/** Claude's session ids are UUIDs; anything else is not forwarded. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const TOKEN = /^[0-9a-f]{64}$/u;

export interface AgentHookServerOptions {
  /** `app.getPath("userData")`; the settings files live under it. */
  userDataPath: string;
  log?(event: string, meta?: Record<string, unknown>): void;
  /** Installed Claude Code version, or null when it cannot be told. */
  probeClaudeVersion?: () => Promise<string | null>;
  now?: () => number;
}

type Listener = (payload: AgentHookEventPayload) => void;

interface ServerState {
  port: number;
  token: string;
}

/**
 * `--settings` content for one pane: one HTTP hook per status event, all to
 * `url`, all carrying the pane id as a literal header. Not `$HT_PANE_ID`:
 * a background session reads its env from Claude's supervisor, which holds
 * the env of the pane that started it, so every session would report as
 * that pane.
 */
export function buildClaudeHookSettings(url: string, paneId: string): {
  hooks: Record<string, Array<Record<string, unknown>>>;
} {
  // Written into a file Claude interprets; the shape also rules out a `$`
  // that Claude would try to expand.
  if (!AGENT_HOOK_PANE_ID.test(paneId)) {
    throw new TypeError("invalid pane id");
  }
  const handler = {
    type: "http",
    url,
    timeout: HOOK_TIMEOUT_SECONDS,
    headers: { [AGENT_HOOK_PANE_HEADER]: paneId },
  };
  const hooks: Record<string, Array<Record<string, unknown>>> = {};
  for (const { event, matcher } of CLAUDE_STATUS_HOOK_EVENTS) {
    hooks[event] = [{ ...(matcher ? { matcher: "*" } : {}), hooks: [handler] }];
  }
  return { hooks };
}

/** `2.1.283 (Claude Code)` → `2.1.283`. A login shell may print its own
 * noise around it, so the Claude line wins over any other version number. */
export function parseClaudeVersion(output: string): string | null {
  const claude = /(\d+)\.(\d+)\.(\d+)[^\n]*\(Claude Code\)/u.exec(output);
  if (claude) return `${claude[1]}.${claude[2]}.${claude[3]}`;
  const bare = /^\s*v?(\d+)\.(\d+)\.(\d+)\b/mu.exec(output);
  return bare ? `${bare[1]}.${bare[2]}.${bare[3]}` : null;
}

/** Numeric major.minor.patch comparison; missing parts count as 0. */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function shortString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, MAX_FIELD_LENGTH);
}

/** The string value of a top-level-looking `"key": "value"` pair. A value
 * inside another string has its quotes escaped, so it cannot match. */
function scanField(text: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){0,${MAX_FIELD_LENGTH}})"`, "u")
    .exec(text);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

const HOOK_FIELDS = [
  "hook_event_name",
  "notification_type",
  "tool_name",
  "agent_type",
  "error",
  "session_id",
] as const;

/**
 * The fields the status needs from a hook body. `complete` is false when the
 * body went past the cap, in which case only its head is looked at.
 */
export function extractHookFields(
  body: Buffer,
  complete: boolean,
): Partial<Record<(typeof HOOK_FIELDS)[number], unknown>> | null {
  if (complete) {
    try {
      const parsed: unknown = JSON.parse(body.toString("utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      // Fall through to the scan: a truncated or odd body still names its event.
    }
  }
  const head = body.subarray(0, FALLBACK_SCAN_BYTES).toString("utf8");
  const fields: Partial<Record<(typeof HOOK_FIELDS)[number], unknown>> = {};
  for (const key of HOOK_FIELDS) {
    const value = scanField(head, key);
    if (value !== undefined) fields[key] = value;
  }
  return fields.hook_event_name === undefined ? null : fields;
}

/** Trims a hook body to the renderer contract; null when it names no event. */
export function toHookPayload(
  paneId: string,
  fields: Partial<Record<(typeof HOOK_FIELDS)[number], unknown>>,
  receivedAt: number,
): AgentHookEventPayload | null {
  const event = fields.hook_event_name;
  if (typeof event !== "string" || !EVENT_NAME.test(event)) return null;
  const notificationType = shortString(fields.notification_type);
  const toolName = shortString(fields.tool_name);
  // An empty agent_type is meaningful (Claude's internal agent), so it is
  // kept as "" instead of being dropped with the absent ones.
  const agentType = shortString(fields.agent_type);
  // StopFailure reports a code string; PostToolUseFailure an error message.
  const error = shortString(fields.error);
  // Lets a pane tell its own conversation from a background session that
  // was dispatched with its settings file.
  const sessionId = typeof fields.session_id === "string" ? fields.session_id.trim() : "";
  return {
    paneId,
    source: "claude",
    event,
    ...(notificationType ? { notificationType } : {}),
    ...(toolName ? { toolName } : {}),
    ...(agentType !== undefined ? { agentType } : {}),
    ...(error ? { error } : {}),
    ...(SESSION_ID.test(sessionId) ? { sessionId } : {}),
    receivedAt,
  };
}

/**
 * The version of the `claude` a pane would start. On Windows the pane's own
 * PowerShell is asked — the same resolution of `claude` (PATH, an npm
 * `.ps1`/`.cmd` shim) the pane script gets — and nothing path-shaped goes
 * through a console code page or cmd.exe's parser: `where.exe` wrote a
 * `C:\Users\João` in the OEM code page, and cmd.exe split a shim path at its
 * `&`. The version line itself is ASCII. Elsewhere a login zsh with the same
 * PATH export the pane script uses.
 */
export async function probeInstalledClaudeVersion(
  platform: NodeJS.Platform = process.platform,
  powerShell: () => string = resolvePowerShell,
): Promise<string | null> {
  const options = { timeoutMs: VERSION_PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 };
  try {
    if (platform === "win32") {
      // No profile: it can take seconds and print its own noise, and the
      // pane finds `claude` on the PATH either way. Bypass like the pane, or
      // a `claude.ps1` shim would not run under a Restricted policy.
      const { stdout } = await runCommand(
        powerShell(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "claude --version",
        ],
        options,
      );
      return parseClaudeVersion(stdout);
    }
    const { stdout } = await runCommand(
      "zsh",
      ["-lc", `${UNIX_USER_BIN_PATH_EXPORT}; claude --version`],
      options,
    );
    return parseClaudeVersion(stdout);
  } catch {
    return null;
  }
}

async function writeFileAtomically(target: string, contents: string): Promise<void> {
  // Unique per write: two spawns of one pane may rewrite its file at once.
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporary, target);
  } catch {
    // Windows refuses to replace a file another process holds open; a plain
    // overwrite still works there.
    await rm(temporary, { force: true });
    await writeFile(target, contents, { encoding: "utf8", mode: 0o600 });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AgentHookServer {
  private readonly log: (event: string, meta?: Record<string, unknown>) => void;
  private readonly probeClaudeVersion: () => Promise<string | null>;
  private readonly now: () => number;
  private readonly directory: string;
  private readonly panesDirectory: string;
  private readonly statePath: string;
  private readonly listeners = new Set<Listener>();
  private token = "";
  private server: Server | null = null;
  private port = 0;
  private startPromise: Promise<void> | null = null;
  private closed = false;
  private versionCheck: { at: number; result: Promise<boolean> } | null = null;

  constructor(options: AgentHookServerOptions) {
    this.log = options.log ?? (() => undefined);
    this.probeClaudeVersion = options.probeClaudeVersion ?? (() => probeInstalledClaudeVersion());
    this.now = options.now ?? Date.now;
    this.directory = path.join(options.userDataPath, SETTINGS_DIR);
    this.panesDirectory = path.join(this.directory, PANES_DIR);
    this.statePath = path.join(this.directory, STATE_FILE);
  }

  /** Loopback URL the hooks post to, token included. Empty before start. */
  get hookUrl(): string {
    return this.port ? `http://127.0.0.1:${this.port}${HOOK_PATH_PREFIX}${this.token}` : "";
  }

  start(): Promise<void> {
    this.startPromise ??= this.listen().catch((error: unknown) => {
      this.log("agent-hooks.start_failed", { reason: errorMessage(error) });
      throw error;
    });
    return this.startPromise;
  }

  /** The server, the pane files and the `claude --version` probe, ahead of
   * the first pane, so a restored Claude pane finds them ready. */
  async warmUp(): Promise<void> {
    try {
      await this.start();
    } catch {
      return;
    }
    await this.claudeSupportsHooks();
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The `--settings` file of one pane, or null when the server is not up,
   * the file could not be written, or the installed Claude is too old to
   * take HTTP hooks — the pane then falls back to its title and screen.
   * Asked on every spawn: the file is (re)written right here when it is
   * missing or stale, because Claude refuses to start on a settings file
   * that is not there.
   */
  async getClaudeSettings(paneId: string): Promise<ClaudeHookSettings | null> {
    if (!AGENT_HOOK_PANE_ID.test(paneId)) return null;
    try {
      await this.start();
    } catch {
      return null;
    }
    if (this.closed || !this.port) return null;
    if (!(await this.claudeSupportsHooks())) return null;
    const settingsPath = this.paneSettingsPath(paneId);
    try {
      const contents = this.paneSettingsJson(paneId);
      const current = await readFile(settingsPath, "utf8").catch(() => null);
      const now = new Date();
      // An up-to-date file is only touched: in use, so the startup prune
      // leaves it alone. Missing (deleted under the app), stale or gone
      // between the read and the touch, it is written again.
      const touched = current === contents
        && (await utimes(settingsPath, now, now).then(() => true, () => false));
      if (!touched) {
        await mkdir(this.panesDirectory, { recursive: true, mode: 0o700 });
        await writeFileAtomically(settingsPath, contents);
      }
    } catch (error) {
      this.log("agent-hooks.settings_write_failed", { paneId, reason: errorMessage(error) });
      return null;
    }
    return this.closed ? null : { settingsPath };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private paneSettingsPath(paneId: string): string {
    return path.join(this.panesDirectory, `${paneId}.json`);
  }

  private paneSettingsJson(paneId: string): string {
    return `${JSON.stringify(buildClaudeHookSettings(this.hookUrl, paneId), null, 2)}\n`;
  }

  private claudeSupportsHooks(): Promise<boolean> {
    const now = this.now();
    const cached = this.versionCheck;
    if (cached && now - cached.at < VERSION_RETRY_MS) return cached.result;
    const result = this.probeClaudeVersion().then(
      (version) => {
        const supported = version !== null
          && compareVersions(version, MIN_CLAUDE_HOOKS_VERSION) >= 0;
        this.log("agent-hooks.claude_version", {
          version,
          minimum: MIN_CLAUDE_HOOKS_VERSION,
          supported,
        });
        // A supported install stays supported for the run; anything else is
        // asked again later instead of disabling hooks until a restart.
        if (supported) this.versionCheck = { at: Number.POSITIVE_INFINITY, result };
        return supported;
      },
      () => false,
    );
    this.versionCheck = { at: now, result };
    return result;
  }

  private async readState(): Promise<ServerState | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.statePath, "utf8"));
      const { port, token } = (parsed ?? {}) as Partial<ServerState>;
      if (
        typeof port === "number"
        && Number.isInteger(port)
        && port > 0
        && port < 65_536
        && typeof token === "string"
        && TOKEN.test(token)
      ) {
        return { port, token };
      }
    } catch {
      // First run, or a damaged file: a new port and token it is.
    }
    return null;
  }

  private bind(port: number): Promise<Server> {
    const server = createServer((request, response) => this.handle(request, response));
    // Hooks are one small POST each; nothing legitimate idles on a socket.
    server.headersTimeout = 5_000;
    server.requestTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve(server);
      });
    });
  }

  private async listen(): Promise<void> {
    const saved = await this.readState();
    let server: Server | null = null;
    if (saved) {
      // Same port and token as the last run: background sessions that
      // outlived it keep reaching the app instead of an ECONNREFUSED, or
      // whatever else took the port, on every hook.
      this.token = saved.token;
      try {
        server = await this.bind(saved.port);
      } catch (error) {
        // Taken (EADDRINUSE), or reserved since (EACCES: Windows hands out
        // excluded port ranges at boot). Either way the run needs a port.
        this.log("agent-hooks.saved_port_unavailable", {
          port: saved.port,
          reason: (error as NodeJS.ErrnoException).code ?? errorMessage(error),
        });
      }
    }
    if (!server) {
      // A new port gets a new token: whoever holds the old port may have
      // seen the old one in the hook URLs.
      this.token = randomBytes(32).toString("hex");
      server = await this.bind(0);
    }
    server.on("error", (error) => {
      this.log("agent-hooks.server_error", { reason: error.message });
    });
    server.unref();
    if (this.closed) {
      server.close();
      return;
    }
    this.server = server;
    this.port = (server.address() as AddressInfo).port;

    const changed = !saved || saved.port !== this.port || saved.token !== this.token;
    if (changed) {
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFileAtomically(
          this.statePath,
          `${JSON.stringify({ port: this.port, token: this.token })}\n`,
        );
      } catch (error) {
        this.log("agent-hooks.state_write_failed", { reason: errorMessage(error) });
      }
    }
    await this.reconcilePaneFiles();
    this.log("agent-hooks.started", { port: this.port, reused: !changed });
  }

  /**
   * Startup pass over the pane files earlier runs left. Each one that is
   * still in date is pointed at this run's URL — a background worker that
   * respawns re-reads it — which rewrites nothing unless the port, the token
   * or the file format changed. Files no spawn asked for in
   * PANE_FILE_MAX_AGE_MS are removed; nothing else ever removes one.
   */
  private async reconcilePaneFiles(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.panesDirectory);
    } catch {
      return;
    }
    // File times are wall-clock; the injected clock is for events and retries.
    const cutoff = Date.now() - PANE_FILE_MAX_AGE_MS;
    let rewritten = 0;
    let pruned = 0;
    await Promise.all(names.map(async (name) => {
      const target = path.join(this.panesDirectory, name);
      const paneId = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
      // A temp file only a crash mid-write leaves behind; Claude never sees one.
      const leftover = name.endsWith(".tmp");
      if (!leftover && !AGENT_HOOK_PANE_ID.test(paneId)) return;
      try {
        const info = await stat(target);
        if (!info.isFile()) return;
        if (info.mtimeMs < cutoff) {
          await rm(target, { force: true });
          if (!leftover) pruned += 1;
          return;
        }
        if (leftover) return;
        const contents = this.paneSettingsJson(paneId);
        if ((await readFile(target, "utf8")) === contents) return;
        await writeFileAtomically(target, contents);
        // Pointing a file at the new URL is not using it: the age the prune
        // reads stays the one of the last spawn that asked for it.
        await utimes(target, info.atime, info.mtime);
        rewritten += 1;
      } catch (error) {
        this.log("agent-hooks.pane_file_failed", { file: name, reason: errorMessage(error) });
      }
    }));
    if (rewritten || pruned) {
      this.log("agent-hooks.pane_files", { rewritten, pruned });
    }
  }

  private isHookPath(url: string | undefined): boolean {
    if (!this.token || !url?.startsWith(HOOK_PATH_PREFIX)) return false;
    const given = Buffer.from(url.slice(HOOK_PATH_PREFIX.length));
    const expected = Buffer.from(this.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** DNS rebinding guard: a hook addresses the loopback literally. */
  private isLoopbackHost(host: string | undefined): boolean {
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    request.on("error", () => undefined);
    response.on("error", () => undefined);
    const refuse = (status: number) => {
      response.writeHead(status, { "Content-Length": "0", Connection: "close" });
      response.end();
      request.resume();
    };
    if (request.method !== "POST" || !this.isHookPath(request.url)) {
      refuse(404);
      return;
    }
    // Claude never sends an Origin; a browser always does on a POST. The token
    // is the real lock — this keeps a web page from even trying.
    if (request.headers.origin !== undefined || !this.isLoopbackHost(request.headers.host)) {
      refuse(403);
      return;
    }

    const receivedAt = this.now();
    const header = request.headers[AGENT_HOOK_PANE_HEADER];
    const paneId = typeof header === "string" && AGENT_HOOK_PANE_ID.test(header) ? header : null;
    const chunks: Buffer[] = [];
    let buffered = 0;
    let complete = true;
    request.on("data", (chunk: Buffer) => {
      if (!paneId || !complete) return;
      if (buffered + chunk.length > MAX_HOOK_BODY_BYTES) {
        chunks.push(chunk.subarray(0, MAX_HOOK_BODY_BYTES - buffered));
        buffered = MAX_HOOK_BODY_BYTES;
        complete = false;
        return;
      }
      chunks.push(chunk);
      buffered += chunk.length;
    });
    request.on("end", () => {
      // An empty object is "no decision" for every event, PermissionRequest
      // included: the user still answers Claude's own dialog.
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "2" });
      response.end("{}");
      // Without a valid pane id the event has nowhere to go.
      if (!paneId || this.closed) return;
      const fields = extractHookFields(Buffer.concat(chunks), complete);
      const payload = fields && toHookPayload(paneId, fields, receivedAt);
      if (!payload) return;
      for (const listener of this.listeners) {
        try {
          listener(payload);
        } catch (error) {
          this.log("agent-hooks.listener_failed", { reason: errorMessage(error) });
        }
      }
    });
  }
}
