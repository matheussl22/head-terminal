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

function runCliDiscovery(): Promise<string> {
  // The command is constant. No renderer-controlled value is interpolated into
  // the login shell, which is used so user-installed CLI paths are available.
  const command = [
    "command -v agy >/dev/null 2>&1 && echo antigravity",
    // Either spelling counts: see CURSOR_SHIM in src/config/agents.ts.
    "{ command -v cursor-agent || command -v cursor; } >/dev/null 2>&1 && echo cursor",
    "command -v claude >/dev/null 2>&1 && echo claude",
    "command -v codex >/dev/null 2>&1 && echo codex",
  ].join("; ");

  // A missing final CLI makes the shell status non-zero; stdout from the
  // preceding probes is still valid and must not be discarded.
  return runCommand("zsh", ["-lc", command], {
    maxBuffer: 64 * 1024,
    timeoutMs: CLI_CHECK_TIMEOUT_MS,
  }).then(
    (result) => result.stdout,
    (error) => (error as { stdout?: string }).stdout ?? "",
  );
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
