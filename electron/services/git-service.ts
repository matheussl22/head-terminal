import { stat } from "node:fs/promises";

import { runCommand, type CommandFailure } from "./command-runner";

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

function validateCwd(cwd: string): string {
  if (
    typeof cwd !== "string" ||
    cwd.trim().length === 0 ||
    cwd.length > MAX_PATH_LENGTH ||
    cwd.includes("\0")
  ) {
    throw new Error("Diretório inválido");
  }
  return cwd;
}

async function executeGit(args: readonly string[]): Promise<GitResult> {
  try {
    // Paths in `args` are POSIX and stay POSIX: in WSL mode this is the git
    // inside the distro, so nothing the user sees needs translating.
    const { stdout, stderr } = await runCommand("git", args, {
      maxBuffer: GIT_MAX_BUFFER,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const failure = error as CommandFailure;
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}

async function tryGit(args: readonly string[]): Promise<GitResult | null> {
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

  const [branchResult, headResult, headRefResult, statusResult] =
    await Promise.all([
      tryGit(["-C", repoRoot, "symbolic-ref", "--short", "HEAD"]),
      tryGit(["-C", repoRoot, "rev-parse", "--short", "HEAD"]),
      tryGit(["-C", repoRoot, "symbolic-ref", "HEAD"]),
      tryGit(["-C", repoRoot, "status", "--porcelain"]),
    ]);

  const branch = branchResult?.stdout || null;
  const headShort = headResult?.stdout || null;
  const headRef = headRefResult?.stdout || headShort || "";

  return {
    repoRoot,
    branch,
    headShort,
    headRef,
    isDirty: Boolean(statusResult?.stdout),
  };
}

/** Diff against HEAD followed by the legacy untracked-file annotations. */
export async function getSessionDiff(cwd: string): Promise<string> {
  const repoRoot = await resolveRepoRoot(cwd);
  if (!repoRoot) {
    throw new Error("O diretório não é um repositório git");
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Creates a sibling `<repo>-agent-N` worktree on branch `agent-N`. */
export async function createSessionWorktree(cwd: string): Promise<string> {
  const repoRoot = await resolveRepoRoot(cwd);
  if (!repoRoot) {
    throw new Error("O diretório não é um repositório git");
  }

  for (let n = 1; n < 100; n += 1) {
    const branch = `agent-${n}`;
    const path = `${repoRoot}-${branch}`;
    const branchExists = await tryGit([
      "-C",
      repoRoot,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);

    if ((await exists(path)) || branchExists !== null) {
      continue;
    }

    await executeGit([
      "-C",
      repoRoot,
      "worktree",
      "add",
      path,
      "-b",
      branch,
    ]);
    return path;
  }

  throw new Error("Limite de worktrees atingido");
}

// Names used by the preload contract.
export const getContext = getGitContext;
export const getDiff = getSessionDiff;
export const createWorktree = createSessionWorktree;
