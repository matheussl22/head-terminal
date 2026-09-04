import { lstat, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { runCommand } from "./command-runner";
import { HT_UNIX_CMD_FN, UNIX_USER_BIN_PATH_EXPORT } from "../../src/core/unix-cli-probe";

const CLAUDE_PROFILE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLI_CHECK_TIMEOUT_MS = 5_000;
const MAX_PATH_LENGTH = 4_096;

export interface AgentCliStatus {
  antigravity: boolean;
  cursor: boolean;
  claude: boolean;
  codex: boolean;
  ollama: boolean;
  ornith: boolean;
}

function validatePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.includes("\0")
  ) {
    throw new Error("Caminho inválido");
  }
  return value;
}

/** Overridable so tests never depend on the real home. */
let homeOverride: string | null = null;

export function setHomeOverride(home: string | null): void {
  homeOverride = home;
}

export function getHome(): string {
  return homeOverride ?? homedir();
}

/**
 * The user's documents folder when there is one — `Documentos` on a machine
 * set up in Portuguese, `Documents` otherwise — else the home. A pane whose
 * cwd does not exist cannot start at all, so the fallback must always exist.
 */
export async function getDefaultCwd(): Promise<string> {
  const home = getHome();
  for (const name of ["Documentos", "Documents"]) {
    const candidate = join(home, name);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return home;
}

/** `path_exists` historically means "is an existing directory". */
export async function pathExists(path: string): Promise<boolean> {
  try {
    return (await stat(validatePath(path))).isDirectory();
  } catch {
    return false;
  }
}

async function runZshCliDiscovery(): Promise<{ stdout: string; ran: boolean }> {
  // The command is constant. No renderer-controlled value is interpolated into
  // the login shell, which is used so user-installed CLI paths are available.
  const command = [
    UNIX_USER_BIN_PATH_EXPORT,
    "command -v agy >/dev/null 2>&1 && echo antigravity",
    // Same Unix-native filter as CURSOR_SHIM: a Windows .cmd on /mnt/c is not
    // a working pane CLI, so discovery must not hide a missing Linux install.
    `${HT_UNIX_CMD_FN}{ ht_unix_cmd cursor-agent || ht_unix_cmd cursor; } >/dev/null 2>&1 && echo cursor`,
    "command -v claude >/dev/null 2>&1 && echo claude",
    "command -v codex >/dev/null 2>&1 && echo codex",
    "command -v ollama >/dev/null 2>&1 && echo ollama",
    "command -v llama-cli >/dev/null 2>&1 && echo ornith",
  ].join("; ");

  try {
    const result = await runCommand("zsh", ["-lc", command], {
      maxBuffer: 64 * 1024,
      timeoutMs: CLI_CHECK_TIMEOUT_MS,
    });
    return { stdout: result.stdout, ran: true };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string };
    // A shell that started and exited non-zero still produced a valid probe
    // — the last missing CLI just makes the status non-zero. A missing zsh
    // produced nothing.
    if (failure.code === "ENOENT") {
      return { stdout: "", ran: false };
    }
    return { stdout: failure.stdout ?? "", ran: true };
  }
}

function windowsHasCommand(name: string): Promise<boolean> {
  return runCommand("where.exe", [name], {
    maxBuffer: 64 * 1024,
    timeoutMs: CLI_CHECK_TIMEOUT_MS,
  }).then(
    (result) => result.stdout.trim().length > 0,
    () => false,
  );
}

async function runWindowsCliDiscovery(): Promise<string> {
  const probes: Array<[string, readonly string[]]> = [
    ["antigravity", ["agy"]],
    ["cursor", ["cursor-agent", "cursor"]],
    ["claude", ["claude"]],
    ["codex", ["codex"]],
    ["ollama", ["ollama"]],
    ["ornith", ["llama-cli"]],
  ];
  const found: string[] = [];
  for (const [id, names] of probes) {
    for (const name of names) {
      if (await windowsHasCommand(name)) {
        found.push(id);
        break;
      }
    }
  }
  return found.join("\n");
}

async function runCliDiscovery(platform: NodeJS.Platform): Promise<string> {
  if (platform === "win32") {
    return runWindowsCliDiscovery();
  }
  return (await runZshCliDiscovery()).stdout;
}

/** `platform` is injectable so the POSIX probe is testable on a Windows host. */
export async function checkAgentClis(
  platform: NodeJS.Platform = process.platform,
): Promise<AgentCliStatus> {
  const found = new Set((await runCliDiscovery(platform)).split(/\r?\n/u));
  return {
    antigravity: found.has("antigravity"),
    cursor: found.has("cursor"),
    claude: found.has("claude"),
    codex: found.has("codex"),
    ollama: found.has("ollama"),
    ornith: found.has("ornith"),
  };
}

/**
 * Models already pulled on this machine, newest listing order preserved.
 *
 * `ollama list` needs the daemon up; when it is down — or ollama is not
 * installed — the command fails and the answer is an empty list, which the
 * dialog turns into "type the name yourself" rather than an error.
 */
export async function listOllamaModels(): Promise<string[]> {
  const stdout = await runCommand("ollama", ["list"], {
    maxBuffer: 256 * 1024,
    timeoutMs: CLI_CHECK_TIMEOUT_MS,
  }).then(
    (result) => result.stdout,
    () => "",
  );

  return stdout
    .split(/\r?\n/u)
    .slice(1) // header row: NAME  ID  SIZE  MODIFIED
    .map((line) => line.split(/\s+/u)[0]?.trim() ?? "")
    .filter((name) => name.length > 0 && name.length <= 128)
    .slice(0, 200);
}

function claudeProfilesRoot(): string {
  return resolve(join(getHome(), ".head-terminal", "claude-profiles"));
}

/**
 * Removes only direct UUID-shaped children of Head Terminal's profile root.
 * Symlinks are rejected so a manipulated profile cannot redirect recursive
 * deletion outside the managed directory.
 */
export async function deleteClaudeProfileDir(path: string): Promise<void> {
  const target = resolve(validatePath(path));
  const root = claudeProfilesRoot();
  const profileId = target.slice(root.length + 1);

  if (
    target === root ||
    target !== join(root, profileId) ||
    !CLAUDE_PROFILE_ID.test(profileId)
  ) {
    throw new Error("Caminho de perfil inválido");
  }

  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error("Diretório de perfis inválido");
    }
    if ((await realpath(root)) !== root) {
      throw new Error("Diretório de perfis inválido");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }

  try {
    const targetInfo = await lstat(target);
    if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
      throw new Error("Caminho de perfil inválido");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }

  await rm(target, { recursive: true, force: false });
}

// Name used by the preload contract.
export const deleteClaudeProfile = deleteClaudeProfileDir;
