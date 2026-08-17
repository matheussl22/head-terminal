import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import { PANE_MARKER_ENV, withWslEnvPassthrough } from "./wsl-service";

const require = createRequire(import.meta.url);

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_DIMENSION = 1_000;
const PANE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface Disposable {
  dispose(): void;
}

/** The subset of node-pty used by the service. Kept small for easy unit tests. */
export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): Disposable;
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): Disposable;
}

export interface NodePtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type SpawnPty = (
  file: string,
  args: string[],
  options: NodePtySpawnOptions,
) => PtyProcess;

export interface PtySpawnRequest {
  id: string;
  command: string;
  args?: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

/**
 * What `PtyService` needs from `WslService`. Structural so tests can supply a
 * two-line stub and production can pass the real thing.
 */
export interface WslBridge {
  isWslMode(): boolean;
  wrap(
    command: string,
    args: readonly string[],
    cwd: string,
  ): { file: string; args: string[] };
  spawnCwd(posix: string, windowsFallback: string): string;
  killPaneTree(marker: string): Promise<void>;
}

/** Pane variables that must survive the crossing into the distro. */
const WSL_FORWARDED_ENV = [
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "CLAUDE_CONFIG_DIR",
  PANE_MARKER_ENV,
] as const;

export interface PtySpawnResult {
  id: string;
  pid: number;
}

export type PtyServiceEvent =
  | {
      channel: "pty:data";
      ownerId: number;
      payload: { id: string; data: string };
    }
  | {
      channel: "pty:exit";
      ownerId: number;
      payload: { id: string; exitCode: number; signal?: number };
    };

export interface PtyServiceOptions {
  /** Delivers an event to the WebContents identified by ownerId. */
  emit?: (event: PtyServiceEvent) => void;
  /** Dependency injection seam; production defaults to node-pty.spawn. */
  spawn?: SpawnPty;
  /** Base environment inherited by child processes. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Present only on Windows, where every argv is wrapped into WSL. */
  wsl?: WslBridge;
  /** Directory the Windows launcher itself starts in. Defaults to the home. */
  windowsHome?: string;
}

interface PtyEntry {
  id: string;
  ownerId: number;
  process: PtyProcess;
  listeners: Disposable[];
  /** Set in WSL mode: identifies the Linux process tree behind `wsl.exe`. */
  wslMarker?: string;
}

interface NodePtyModule {
  spawn: SpawnPty;
}

function loadNodePty(): NodePtyModule {
  try {
    try {
      return require("node-pty") as NodePtyModule;
    } catch {
      // Production Vite builds stage the package beside main.js. Its `.node`
      // file is unpacked from ASAR by AutoUnpackNativesPlugin.
      return require("./native/node-pty") as NodePtyModule;
    }
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `node-pty is unavailable${detail}. Rebuild it for the current Electron version.`,
      { cause: error },
    );
  }
}

function assertOwnerId(ownerId: number): void {
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
    throw new TypeError("PTY ownerId must be a positive WebContents id");
  }
}

function assertPaneId(id: string): void {
  if (typeof id !== "string" || !PANE_ID_PATTERN.test(id)) {
    throw new TypeError(
      "PTY id must contain 1-128 letters, numbers, dots, colons, underscores or hyphens",
    );
  }
}

function assertText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`PTY ${field} must be a non-empty string without NUL bytes`);
  }
}

function normalizeDimension(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_DIMENSION) {
    throw new RangeError(
      `PTY ${field} must be an integer between 1 and ${MAX_DIMENSION}`,
    );
  }
  return value;
}

function normalizeArgs(args: string[] | undefined): string[] {
  if (args === undefined) return [];
  if (!Array.isArray(args)) throw new TypeError("PTY args must be an array");
  return args.map((arg) => {
    if (typeof arg !== "string" || arg.includes("\0")) {
      throw new TypeError("PTY args must contain only strings without NUL bytes");
    }
    return arg;
  });
}

/** Environment an agent CLI uses to recognise that it is running *inside*
 * another agent session. Anything matching this or the `CLAUDE_CODE_` prefix
 * describes the parent, never a pane. */
const PARENT_AGENT_ENV = new Set([
  "AI_AGENT",
  "CLAUDECODE",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
]);

function buildEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }

  // GUI launchers may inherit these from test runners or desktop wrappers.
  // A real PTY is color-capable, so inherited output preferences must not leak.
  delete env.NO_COLOR;
  delete env.NODE_DISABLE_COLORS;

  // The app itself can be started from inside an agent session — a terminal
  // running Claude Code, an agent-driven `npm run start:dev`. Those markers
  // make the CLI in a pane behave as a nested child session: transcript
  // saving is off, so nothing it does is saved or resumable, and an
  // inherited CLAUDE_CONFIG_DIR silently overrides the pane's own account.
  // A pane is always a top-level session. The per-pane overrides below still
  // win, and a login shell still applies whatever the user's own profile sets.
  for (const key of Object.keys(env)) {
    if (PARENT_AGENT_ENV.has(key) || key.startsWith("CLAUDE_CODE_")) {
      delete env[key];
    }
  }

  Object.assign(env, {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  });

  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new TypeError(`Invalid PTY environment variable name: ${key}`);
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw new TypeError(`PTY environment variable ${key} must be a NUL-free string`);
    }
    env[key] = value;
  }

  return env;
}

function registryKey(ownerId: number, id: string): string {
  return `${ownerId}\0${id}`;
}

function linuxDescendants(pid: number, seen = new Set<number>()): number[] {
  if (process.platform !== "linux" || seen.has(pid)) return [];
  seen.add(pid);
  try {
    const children = readFileSync(
      `/proc/${pid}/task/${pid}/children`,
      "utf8",
    )
      .trim()
      .split(/\s+/u)
      .map(Number)
      .filter((child) => Number.isSafeInteger(child) && child > 0);
    return children.flatMap((child) => [
      ...linuxDescendants(child, seen),
      child,
    ]);
  } catch {
    return [];
  }
}

/**
 * Owns all main-process PTYs and enforces WebContents-level isolation.
 *
 * IPC handlers should always pass `event.sender.id` as ownerId. Call
 * `cleanup(ownerId)` when those webContents are destroyed, and `dispose()` on
 * application shutdown.
 */
export class PtyService {
  private readonly entries = new Map<string, PtyEntry>();
  private readonly emit: (event: PtyServiceEvent) => void;
  private readonly spawnPty: SpawnPty;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly wsl: WslBridge | null;
  private readonly windowsHome: string;

  constructor(options: PtyServiceOptions = {}) {
    this.emit = options.emit ?? (() => undefined);
    this.spawnPty =
      options.spawn ??
      ((file, args, spawnOptions) =>
        loadNodePty().spawn(file, args, spawnOptions));
    this.baseEnv = options.env ?? process.env;
    this.wsl = options.wsl ?? null;
    this.windowsHome = options.windowsHome ?? homedir();
  }

  spawn(ownerId: number, request: PtySpawnRequest): PtySpawnResult {
    assertOwnerId(ownerId);
    if (!request || typeof request !== "object") {
      throw new TypeError("PTY spawn request must be an object");
    }
    assertPaneId(request.id);
    assertText(request.command, "command");
    assertText(request.cwd, "cwd");

    const key = registryKey(ownerId, request.id);
    if (this.entries.has(key)) {
      throw new Error(`PTY already exists for pane ${request.id}`);
    }

    const args = normalizeArgs(request.args);
    const cols = normalizeDimension(request.cols, DEFAULT_COLS, "cols");
    const rows = normalizeDimension(request.rows, DEFAULT_ROWS, "rows");
    let env = buildEnvironment(this.baseEnv, request.env);

    // The Windows↔WSL boundary is here and nowhere else: the argv built by
    // the renderer crosses untouched, only wrapped.
    const inWsl = this.wsl?.isWslMode() ?? false;
    const marker = inWsl ? randomUUID() : undefined;
    if (marker) {
      env[PANE_MARKER_ENV] = marker;
      env = withWslEnvPassthrough(env, WSL_FORWARDED_ENV);
    }
    const launch = inWsl
      ? (this.wsl as WslBridge).wrap(request.command, args, request.cwd)
      : { file: request.command, args };
    const cwd = inWsl
      ? (this.wsl as WslBridge).spawnCwd(request.cwd, this.windowsHome)
      : request.cwd;

    const processPty = this.spawnPty(launch.file, launch.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
    });

    const entry: PtyEntry = {
      id: request.id,
      ownerId,
      process: processPty,
      listeners: [],
      ...(marker ? { wslMarker: marker } : {}),
    };
    this.entries.set(key, entry);

    try {
      entry.listeners.push(
        processPty.onData((data) => {
          if (this.entries.get(key) !== entry) return;
          // Deliberately preserve node-pty's string byte-for-byte. xterm needs
          // escape/OSC sequences and must be the component that parses them.
          this.emit({
            channel: "pty:data",
            ownerId,
            payload: { id: request.id, data },
          });
        }),
      );
      entry.listeners.push(
        processPty.onExit(({ exitCode, signal }) => {
          if (this.entries.get(key) !== entry) return;
          this.detachEntry(key, entry, false);
          this.emit({
            channel: "pty:exit",
            ownerId,
            payload: { id: request.id, exitCode, signal },
          });
        }),
      );
    } catch (error) {
      this.detachEntry(key, entry, true);
      throw error;
    }

    return { id: request.id, pid: processPty.pid };
  }

  write(ownerId: number, id: string, data: string): void {
    const entry = this.getOwnedEntry(ownerId, id);
    if (typeof data !== "string") {
      throw new TypeError("PTY data must be a string");
    }
    entry.process.write(data);
  }

  resize(ownerId: number, id: string, cols: number, rows: number): void {
    const entry = this.getOwnedEntry(ownerId, id);
    entry.process.resize(
      normalizeDimension(cols, DEFAULT_COLS, "cols"),
      normalizeDimension(rows, DEFAULT_ROWS, "rows"),
    );
  }

  /** Kills one owned PTY. Returns false when it was already gone. */
  kill(ownerId: number, id: string): boolean {
    assertOwnerId(ownerId);
    assertPaneId(id);
    const key = registryKey(ownerId, id);
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.detachEntry(key, entry, true);
    return true;
  }

  /** Kills all PTYs for one renderer. Safe to call repeatedly. */
  cleanup(ownerId: number): number {
    assertOwnerId(ownerId);
    let killed = 0;
    for (const [key, entry] of [...this.entries]) {
      if (entry.ownerId !== ownerId) continue;
      this.detachEntry(key, entry, true);
      killed += 1;
    }
    return killed;
  }

  /** Kills every PTY. Safe to call on every shutdown path. */
  dispose(): number {
    const entries = [...this.entries];
    for (const [key, entry] of entries) this.detachEntry(key, entry, true);
    return entries.length;
  }

  has(ownerId: number, id: string): boolean {
    assertOwnerId(ownerId);
    assertPaneId(id);
    return this.entries.has(registryKey(ownerId, id));
  }

  get size(): number {
    return this.entries.size;
  }

  private getOwnedEntry(ownerId: number, id: string): PtyEntry {
    assertOwnerId(ownerId);
    assertPaneId(id);
    const entry = this.entries.get(registryKey(ownerId, id));
    if (!entry) throw new Error(`PTY not found for pane ${id}`);
    return entry;
  }

  private detachEntry(key: string, entry: PtyEntry, kill: boolean): void {
    // Delete first: node-pty can synchronously deliver onExit from kill().
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);

    for (const listener of entry.listeners.splice(0)) {
      try {
        listener.dispose();
      } catch {
        // Listener cleanup must not prevent process cleanup.
      }
    }

    if (kill) {
      // In WSL mode the pid belongs to `wsl.exe`; the tree that matters lives
      // inside the distro and is killed there, by marker.
      if (entry.wslMarker && this.wsl) {
        void this.wsl.killPaneTree(entry.wslMarker);
      }
      let descendantPids: number[] = [];
      // node-pty kills the foreground shell, but detached/background children
      // may survive it. On POSIX the PTY child is a session/process-group
      // leader, so terminate the whole group first.
      if (process.platform !== "win32" && entry.process.pid > 0) {
        // Interactive shells put background jobs in their own process group,
        // so the shell group alone is insufficient. Snapshot descendants
        // before killing the parent and signal deepest children first.
        descendantPids = linuxDescendants(entry.process.pid);
        for (const childPid of descendantPids) {
          try {
            process.kill(childPid, "SIGTERM");
          } catch {
            // The child may exit while the tree is being traversed.
          }
        }
        try {
          process.kill(-entry.process.pid, "SIGTERM");
        } catch {
          // ESRCH means the process group already exited.
        }
      }
      try {
        entry.process.kill();
      } catch {
        // The process may have exited between lookup and cleanup.
      }
      // Closing a terminal is a terminal condition: do not let children that
      // trap SIGTERM outlive the application.
      for (const childPid of descendantPids) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // Already exited after SIGTERM.
        }
      }
    }
  }
}
