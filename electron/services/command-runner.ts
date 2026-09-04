import { execFile } from "node:child_process";

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

function execute(
  file: string,
  args: readonly string[],
  options: CommandOptions,
  cwd: string | undefined,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
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
