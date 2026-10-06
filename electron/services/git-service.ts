import { stat } from "node:fs/promises";

import { runCommand, type CommandFailure } from "./command-runner";
import { msg } from "../../src/i18n";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_PATH_LENGTH = 4_096;

export interface GitContextPayload {
  repoRoot: string | null;
  branch: string | null;
  headShort: string | null;
  headRef: string;
  isDirty: boolean;
}

interface GitResult {
  stdout: string;
  stderr: string;
}

function emptyContext(): GitContextPayload {
  return {
    repoRoot: null,
    branch: null,
    headShort: null,
    headRef: "",
    isDirty: false,
  };
}

export function validateCwd(cwd: string): string {
  if (
    typeof cwd !== "string" ||
    cwd.trim().length === 0 ||
    cwd.length > MAX_PATH_LENGTH ||
    cwd.includes("\0")
  ) {
    throw new Error(msg.main.paths.invalidDirectory);
  }
  return cwd;
}

export async function executeGit(
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<GitResult> {
  try {
    // Paths in `args` are POSIX and stay POSIX: in WSL mode this is the git
    // inside the distro, so nothing the user sees needs translating.
    // `--no-optional-locks` stops read-only commands such as `status` from
    // taking .git/index.lock to refresh the index. That lock lands in the
    // directory git-watch-service observes, so every refresh woke the watcher
    // up again. Locks that a write needs are not optional and still apply.
    const { stdout, stderr } = await runCommand("git", ["--no-optional-locks", ...args], {
      maxBuffer: GIT_MAX_BUFFER,
      timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const failure = error as CommandFailure;
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}

export async function tryGit(args: readonly string[]): Promise<GitResult | null> {
  try {
    return await executeGit(args);
  } catch {
    return null;
  }
}

async function resolveRepoRoot(cwd: string): Promise<string | null> {
  const result = await tryGit([
    "-C",
    validateCwd(cwd),
    "rev-parse",
    "--show-toplevel",
  ]);
  return result?.stdout || null;
}

export function parseStatusShort(stdout: string): {
  branch: string | null;
  isDirty: boolean;
} {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  const header = lines[0] ?? "";
  const isDirty = lines.some((_, index) => index > 0);

  if (
    /^## HEAD(?:\s|$)/u.test(header) ||
    /^## \(HEAD detached\b/u.test(header)
  ) {
    return { branch: null, isDirty };
  }

  const noCommits = /^## No commits yet on (.+)$/u.exec(header);
  if (noCommits) {
    return { branch: noCommits[1] ?? null, isDirty };
  }

  const match = /^## ([^\s.]+)/u.exec(header);
  return { branch: match?.[1] ?? null, isDirty };
}

export async function getGitContext(cwd: string): Promise<GitContextPayload> {
  let repoRoot: string | null;
  try {
    repoRoot = await resolveRepoRoot(cwd);
  } catch {
    return emptyContext();
  }
  if (!repoRoot) {
    return emptyContext();
  }

  const [statusResult, headResult] = await Promise.all([
    tryGit(["-C", repoRoot, "status", "--porcelain=v1", "-b"]),
    tryGit(["-C", repoRoot, "rev-parse", "--short", "HEAD"]),
  ]);

  const { branch, isDirty } = parseStatusShort(statusResult?.stdout ?? "");
  const headShort = headResult?.stdout || null;
  const headRef = branch ? `refs/heads/${branch}` : headShort || "";

  return {
    repoRoot,
    branch,
    headShort,
    headRef,
    isDirty,
  };
}

/** Diff against HEAD followed by the legacy untracked-file annotations. */
export async function getSessionDiff(cwd: string): Promise<string> {
  const repoRoot = await resolveRepoRoot(cwd);
  if (!repoRoot) {
    throw new Error(msg.main.git.notARepository);
  }

  const [diffResult, untrackedResult] = await Promise.all([
    tryGit(["-C", repoRoot, "diff", "HEAD", "--"]),
    tryGit([
      "-C",
      repoRoot,
      "ls-files",
      "--others",
      "--exclude-standard",
    ]),
  ]);

  let result = diffResult?.stdout || "";
  const untracked = untrackedResult?.stdout || "";
  if (untracked) {
    if (result) {
      result += "\n";
    }
    for (const file of untracked.split(/\r?\n/u)) {
      result += `?? novo arquivo (untracked): ${file}\n`;
    }
  }
  return result;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Names used by the preload contract.
export const getContext = getGitContext;
export const getDiff = getSessionDiff;
