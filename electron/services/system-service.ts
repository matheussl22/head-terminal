import { lstat, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { runCommand } from "./command-runner";

const CLAUDE_PROFILE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLI_CHECK_TIMEOUT_MS = 5_000;
const MAX_PATH_LENGTH = 4_096;

export interface AgentCliStatus {
  antigravity: boolean;
  cursor: boolean;
  claude: boolean;
  codex: boolean;
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

/**
 * Home the panes actually live in. On Windows that is the WSL `$HOME`, never
 * `C:\Users\...`, and it is installed at startup once the distro is known.
 */
let posixHome: string | null = null;

export function setPosixHome(home: string | null): void {
  posixHome = home;
}

export function getPosixHome(): string {
  return posixHome ?? homedir();
}

/**
 * Turns a POSIX path into one this process can hand to `fs`. It is the
 * identity everywhere except Windows, where the files live inside the distro
 * and are reached over UNC.
 */
let toNativePath: (posix: string) => string = (posix) => posix;

export function setNativePathTranslator(
  translate: (posix: string) => string,
): void {
  toNativePath = translate;
}

/**
 * Matches the Tauri default (`$HOME/Documentos`) without trusting `$HOME`.
 * The folder is only there on a machine set up in Portuguese, and a pane whose
 * cwd does not exist cannot start at all, so the home is the fallback.
 */
export async function getDefaultCwd(): Promise<string> {
  const home = posixHome ?? homedir();
  const documents = posixHome
    ? `${posixHome}/Documentos`
    : join(homedir(), "Documentos");
  return (await pathExists(documents)) ? documents : home;
}

/** `path_exists` historically means "is an existing directory". */
export async function pathExists(path: string): Promise<boolean> {
  try {
    return (await stat(toNativePath(validatePath(path)))).isDirectory();
  } catch {
    return false;
  }
}

async function runZshCliDiscovery(): Promise<{ stdout: string; ran: boolean }> {
  // The command is constant. No renderer-controlled value is interpolated into
  // the login shell, which is used so user-installed CLI paths are available.
  const command = [
    "command -v agy >/dev/null 2>&1 && echo antigravity",
    // Either spelling counts: see CURSOR_SHIM in src/config/agents.ts.
    "{ command -v cursor-agent || command -v cursor; } >/dev/null 2>&1 && echo cursor",
    "command -v claude >/dev/null 2>&1 && echo claude",
    "command -v codex >/dev/null 2>&1 && echo codex",
  ].join("; ");

  try {
    const result = await runCommand("zsh", ["-lc", command], {
      maxBuffer: 64 * 1024,
      timeoutMs: CLI_CHECK_TIMEOUT_MS,
    });
    return { stdout: result.stdout, ran: true };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string };
    // zsh missing (typical Windows without WSL) is not "none of the CLIs
    // exist". A shell that started and exited non-zero still produced a
    // valid probe — the last missing CLI just makes the status non-zero.
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

async function runCliDiscovery(): Promise<string> {
  const posix = await runZshCliDiscovery();
  if (posix.ran || process.platform !== "win32") {
    return posix.stdout;
  }
  // zsh itself is missing: look at native Windows PATH instead of treating
  // every agent as uninstalled.
  return runWindowsCliDiscovery();
}

export async function checkAgentClis(): Promise<AgentCliStatus> {
  const found = new Set((await runCliDiscovery()).split(/\r?\n/u));
  return {
    antigravity: found.has("antigravity"),
    cursor: found.has("cursor"),
    claude: found.has("claude"),
    codex: found.has("codex"),
  };
}

function claudeProfilesRoot(): string {
  return resolve(toNativePath(`${getPosixHome()}/.head-terminal/claude-profiles`));
}

/**
 * Removes only direct UUID-shaped children of Head Terminal's profile root.
 * Symlinks are rejected so a manipulated profile cannot redirect recursive
 * deletion outside the managed directory.
 */
export async function deleteClaudeProfileDir(path: string): Promise<void> {
  const target = resolve(toNativePath(validatePath(path)));
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
