import { execFile } from "node:child_process";

/**
 * The single place where the app starts an external program. Services ask for
 * a POSIX command with POSIX paths and never learn whether it ran natively or
 * inside a distro — on Windows the runner installed at startup wraps it.
 *
 * Anything that calls `execFile` directly breaks Windows silently, so new
 * callers belong here.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export interface CommandOptions {
  /** POSIX working directory. Translated by the WSL runner, not by callers. */
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

export interface WslCommandBridge {
  isWslMode(): boolean;
  wrapCommand(
    command: string,
    args: readonly string[],
    cwd?: string,
  ): { file: string; args: string[] };
}

/**
 * Runs the command inside the distro. The working directory travels as
 * `--cd`, a POSIX path, so the Windows process itself needs none.
 */
export function createWslCommandRunner(wsl: WslCommandBridge): CommandRunner {
  return (command, args, options = {}) => {
    if (!wsl.isWslMode()) {
      return directCommandRunner(command, args, options);
    }
    const wrapped = wsl.wrapCommand(command, args, options.cwd);
    return execute(wrapped.file, wrapped.args, options, undefined);
  };
}

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
