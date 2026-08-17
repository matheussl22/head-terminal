import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

/**
 * The Windows↔WSL boundary. Nothing outside the main process knows it exists:
 * the renderer keeps sending POSIX commands and POSIX paths, and every argv
 * that reaches a real process is wrapped here, at the last possible moment.
 *
 * Every function below is a pure string transform except `detectDistros` and
 * `resolveHome`, which take their runner by injection so the whole module is
 * testable on Linux.
 */

const WSL_LAUNCHER = "wsl.exe";
const WSL_TIMEOUT_MS = 10_000;
const WSL_MAX_BUFFER = 1024 * 1024;
/** `\\wsl.localhost` on current builds; `\\wsl$` on older ones. */
const WSL_UNC_PREFIX = "\\\\wsl.localhost\\";
const WSL_UNC_PATTERN = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$/u;
const WINDOWS_DRIVE_PATTERN = /^([A-Za-z]):(?:\\|\/)(.*)$/u;
const MNT_DRIVE_PATTERN = /^\/mnt\/([a-z])(?:\/(.*))?$/u;

export interface WslArgv {
  file: string;
  args: string[];
}

/** Runs a Windows executable and resolves with its stdout. */
export type WslRunner = (file: string, args: string[]) => Promise<string>;

export function defaultWslRunner(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        // `wsl.exe -l` still answers in UTF-16LE on builds that predate
        // WSL_UTF8, so the raw bytes are decoded rather than assumed.
        encoding: "buffer",
        maxBuffer: WSL_MAX_BUFFER,
        timeout: WSL_TIMEOUT_MS,
        env: { ...process.env, WSL_UTF8: "1" },
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(decodeWslOutput(stdout));
      },
    );
  });
}

/** UTF-16LE output is recognised by the NUL bytes UTF-8 never produces. */
export function decodeWslOutput(stdout: Buffer): string {
  const hasNulBytes = stdout.includes(0);
  return hasNulBytes
    ? stdout.toString("utf16le").replace(/^﻿/u, "")
    : stdout.toString("utf8");
}

export function parseDistroList(raw: string): string[] {
  return raw
    .split(/\r?\n/u)
    .map((line) => line.replaceAll("\0", "").trim())
    .filter((line) => line.length > 0);
}

/**
 * `/home/matheus/x` → `\\wsl.localhost\Ubuntu\home\matheus\x`, and paths that
 * already live on a Windows volume back to their drive letter.
 */
export function toWindowsPath(posix: string, distro: string): string {
  const mounted = MNT_DRIVE_PATTERN.exec(posix);
  if (mounted) {
    const rest = (mounted[2] ?? "").replaceAll("/", "\\");
    return `${mounted[1].toUpperCase()}:\\${rest}`;
  }
  if (!posix.startsWith("/")) {
    return posix;
  }
  return `${WSL_UNC_PREFIX}${distro}${posix.replaceAll("/", "\\")}`;
}

/** Inverse of `toWindowsPath`. POSIX input is returned untouched. */
export function toPosixPath(windows: string): string {
  const unc = WSL_UNC_PATTERN.exec(windows);
  if (unc) {
    const rest = (unc[2] ?? "").replaceAll("\\", "/");
    return rest || "/";
  }
  const drive = WINDOWS_DRIVE_PATTERN.exec(windows);
  if (drive) {
    const rest = drive[2].replaceAll("\\", "/");
    return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
  }
  return windows.replaceAll("\\", "/");
}

/**
 * Wraps a POSIX argv so it runs inside the distro. `--` is what keeps the
 * remaining words out of `wsl.exe`'s own option parsing, so an agent argv is
 * handed to Linux exactly as the renderer wrote it.
 */
export function wrapArgv(
  command: string,
  args: readonly string[],
  cwd: string,
  distro: string,
): WslArgv {
  return {
    file: WSL_LAUNCHER,
    args: ["-d", distro, "--cd", cwd, "--", command, ...args],
  };
}

/** Single-argument form for the services that run one command at a time. */
export function wrapCommand(
  command: string,
  args: readonly string[],
  cwd: string | undefined,
  distro: string,
): WslArgv {
  return cwd === undefined
    ? { file: WSL_LAUNCHER, args: ["-d", distro, "--", command, ...args] }
    : wrapArgv(command, args, cwd, distro);
}

export async function detectDistros(
  runner: WslRunner = defaultWslRunner,
): Promise<string[]> {
  try {
    return parseDistroList(await runner(WSL_LAUNCHER, ["-l", "-q"]));
  } catch {
    return [];
  }
}

export async function resolveHome(
  distro: string,
  runner: WslRunner = defaultWslRunner,
): Promise<string | null> {
  try {
    const output = await runner(WSL_LAUNCHER, [
      "-d",
      distro,
      "--",
      "printenv",
      "HOME",
    ]);
    const home = output.trim();
    return home.startsWith("/") ? home : null;
  } catch {
    return null;
  }
}

/**
 * Windows environment variables do not cross into WSL on their own: only the
 * names listed in WSLENV are carried over. Values are passed verbatim — the
 * `/p` path-translation flag is deliberately unused because every value the
 * app sets is already POSIX.
 */
export function withWslEnvPassthrough(
  env: Record<string, string>,
  keys: readonly string[],
): Record<string, string> {
  const existing = (env.WSLENV ?? "")
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const carried = keys.filter((key) => env[key] !== undefined);
  const merged = [...new Set([...existing, ...carried])];
  return merged.length > 0 ? { ...env, WSLENV: merged.join(":") } : { ...env };
}

/** Marker environment variable every process started for a pane inherits. */
export const PANE_MARKER_ENV = "HEAD_TERMINAL_PANE";
const PANE_MARKER_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;

/**
 * Kills a pane's whole process tree from inside the distro. The Windows side
 * only ever sees the `wsl.exe` pid, and killing that leaves `claude` and its
 * children running in Linux, so the tree is found by the marker every
 * descendant inherited through the environment.
 */
export function paneKillScript(marker: string): string {
  if (!PANE_MARKER_PATTERN.test(marker)) {
    throw new TypeError("Invalid pane marker");
  }
  return [
    "set --",
    "for d in /proc/[0-9]*; do",
    `  if tr '\\0' '\\n' < "$d/environ" 2>/dev/null | grep -qxF ${PANE_MARKER_ENV}=${marker}; then`,
    '    set -- "$@" "${d#/proc/}"',
    "  fi",
    "done",
    '[ "$#" -gt 0 ] || exit 0',
    'kill -TERM "$@" 2>/dev/null',
    "sleep 2",
    'kill -KILL "$@" 2>/dev/null',
    "exit 0",
  ].join("\n");
}

export interface WslServiceOptions {
  platform?: NodeJS.Platform;
  runner?: WslRunner;
  /** Distro chosen by the user; detection fills the gap when absent. */
  preferredDistro?: string | null;
  /** JSON file holding the user's choice across restarts. */
  settingsPath?: string;
}

/**
 * Holds the resolved distro for the process lifetime. `initialize` runs once
 * at startup so every later call is synchronous and cannot block a spawn.
 */
export class WslService {
  readonly #platform: NodeJS.Platform;
  readonly #runner: WslRunner;
  #preferred: string | null;
  readonly #settingsPath: string | null;
  #distro: string | null = null;
  #available: string[] = [];
  #home: string | null = null;

  constructor(options: WslServiceOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#runner = options.runner ?? defaultWslRunner;
    this.#preferred = options.preferredDistro ?? null;
    this.#settingsPath = options.settingsPath ?? null;
  }

  /** True once a usable distro is known. Always false off Windows. */
  isWslMode(): boolean {
    return this.#platform === "win32" && this.#distro !== null;
  }

  get distro(): string | null {
    return this.#distro;
  }

  get availableDistros(): readonly string[] {
    return this.#available;
  }

  /** The WSL `$HOME`, never the Windows one. Null until initialised. */
  get home(): string | null {
    return this.#home;
  }

  async initialize(): Promise<void> {
    if (this.#platform !== "win32") return;
    this.#preferred = this.#preferred ?? (await this.#readSetting());
    this.#available = await detectDistros(this.#runner);
    this.#distro = this.#chooseDistro();
    this.#home = this.#distro
      ? await resolveHome(this.#distro, this.#runner)
      : null;
  }

  /** Applies a distro chosen in the settings UI. Returns false if unknown. */
  async selectDistro(distro: string): Promise<boolean> {
    if (this.#platform !== "win32" || !this.#available.includes(distro)) {
      return false;
    }
    this.#preferred = distro;
    this.#distro = distro;
    this.#home = await resolveHome(distro, this.#runner);
    await this.#writeSetting(distro);
    return true;
  }

  /** Returns the argv unchanged outside WSL mode. */
  wrap(command: string, args: readonly string[], cwd: string): WslArgv {
    return this.isWslMode()
      ? wrapArgv(command, args, cwd, this.#distro as string)
      : { file: command, args: [...args] };
  }

  wrapCommand(
    command: string,
    args: readonly string[],
    cwd?: string,
  ): WslArgv {
    return this.isWslMode()
      ? wrapCommand(command, args, cwd, this.#distro as string)
      : { file: command, args: [...args] };
  }

  /**
   * Directory a *Windows* process may be started in. CreateProcess refuses a
   * UNC working directory, and the POSIX cwd is already carried by `--cd`, so
   * the launcher itself starts wherever Windows allows.
   */
  spawnCwd(posix: string, windowsFallback: string): string {
    if (!this.isWslMode()) return posix;
    const translated = toWindowsPath(posix, this.#distro as string);
    return translated.startsWith("\\\\") ? windowsFallback : translated;
  }

  /** POSIX path as the Windows side must spell it to read the same file. */
  toWindowsPath(posix: string): string {
    return this.isWslMode()
      ? toWindowsPath(posix, this.#distro as string)
      : posix;
  }

  toPosixPath(windows: string): string {
    return this.isWslMode() ? toPosixPath(windows) : windows;
  }

  /**
   * Terminates every Linux process started for a pane. Resolves even when the
   * tree is already gone: closing a pane must never surface an error.
   */
  async killPaneTree(marker: string): Promise<void> {
    if (!this.isWslMode()) return;
    try {
      await this.#runner(WSL_LAUNCHER, [
        "-d",
        this.#distro as string,
        "--",
        "/bin/sh",
        "-c",
        paneKillScript(marker),
      ]);
    } catch {
      // The distro may have stopped, or the tree may have exited first.
    }
  }

  async #readSetting(): Promise<string | null> {
    if (!this.#settingsPath) return null;
    try {
      const parsed: unknown = JSON.parse(
        await readFile(this.#settingsPath, "utf8"),
      );
      const distro = (parsed as { distro?: unknown })?.distro;
      return typeof distro === "string" && distro.length > 0 ? distro : null;
    } catch {
      // No choice stored yet, or the file was hand-edited into nonsense.
      return null;
    }
  }

  async #writeSetting(distro: string): Promise<void> {
    if (!this.#settingsPath) return;
    try {
      await writeFile(
        this.#settingsPath,
        `${JSON.stringify({ distro }, null, 2)}\n`,
        "utf8",
      );
    } catch {
      // A distro that cannot be persisted still applies to this run.
    }
  }

  #chooseDistro(): string | null {
    if (this.#preferred && this.#available.includes(this.#preferred)) {
      return this.#preferred;
    }
    return this.#available[0] ?? null;
  }
}
