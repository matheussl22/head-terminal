import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * The single place where the app starts an external program. The runner is
 * swappable so tests can stand in for the real executables, and so the
 * process-wide defaults (timeout, buffer, hidden window) live in one spot.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

/** Errors keep the child's output: callers report stderr, not "exit code 1". */
export interface CommandFailure extends Error {
  stdout?: string;
  stderr?: string;
}

/**
 * Bare command names resolved against PATH, valid while PATH stays the same.
 * On macOS libuv looks a bare name up by calling posix_spawn on each PATH
 * entry until one works, and every miss still creates and tears down a kernel
 * process that syspolicyd evaluates. The login-shell PATH merged in by
 * shell-env easily puts `git` ten entries deep: eleven processes per call.
 */
const resolvedCommands = new Map<string, string>();
let resolvedForPath: string | undefined;

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The absolute path the search would end on, or `command` untouched when the
 * search is not ours to make: Windows, names with a slash, relative PATH
 * entries (they depend on the child's cwd) and commands PATH does not have.
 */
export async function resolveCommand(command: string): Promise<string> {
  const path = process.env.PATH;
  if (process.platform === "win32" || command.includes("/") || !path) {
    return command;
  }
  if (path !== resolvedForPath) {
    resolvedCommands.clear();
    resolvedForPath = path;
  }
  const cached = resolvedCommands.get(command);
  if (cached !== undefined) {
    return cached;
  }
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) {
      return command;
    }
    const candidate = join(directory, command);
    if (await isExecutableFile(candidate)) {
      resolvedCommands.set(command, candidate);
      return candidate;
    }
  }
  return command;
}

async function execute(
  file: string,
  args: readonly string[],
  options: CommandOptions,
  cwd: string | undefined,
): Promise<CommandResult> {
  const executable = await resolveCommand(file);
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        ...(cwd === undefined ? {} : { cwd }),
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          // The binary found earlier is gone (uninstalled, say): search
          // PATH again on the next call instead of failing until a restart.
          if (executable !== file && error.code === "ENOENT") {
            resolvedCommands.delete(file);
          }
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export const directCommandRunner: CommandRunner = (command, args, options = {}) =>
  execute(command, args, options, options.cwd);

let activeRunner: CommandRunner = directCommandRunner;

/** Installed once at startup, before any service runs a command. */
export function setCommandRunner(runner: CommandRunner): void {
  activeRunner = runner;
}

export function resetCommandRunner(): void {
  activeRunner = directCommandRunner;
}

export const runCommand: CommandRunner = (command, args, options) =>
  activeRunner(command, args, options);
