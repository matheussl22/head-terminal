import { existsSync, lstatSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The Windows side of the platform boundary. Panes on Windows run natively:
 * node-pty's ConPTY hosts a PowerShell, and the agent CLIs are the Windows
 * builds on PATH. Nothing here knows about WSL any more.
 */

/**
 * Abstract shell name the renderer puts in `command`. The renderer cannot know
 * where PowerShell lives (or whether PowerShell 7 is installed), so the main
 * process resolves it at spawn time.
 */
export const POWERSHELL_COMMAND = "powershell";

const WINDOWS_DRIVE = /^([A-Za-z]):(?:[\\/]|$)/u;
const WSL_MOUNT = /^\/mnt\/([a-z])(?:\/(.*))?$/iu;

export interface WindowsShellOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

/**
 * Presence check that also sees Store installs. `WindowsApps\pwsh.exe` is an
 * app execution alias — a reparse point `stat` refuses with EACCES, so
 * `existsSync` says no even though CreateProcess launches it fine. `lstat`
 * looks at the link itself.
 */
function isPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * PowerShell 7 (`pwsh.exe`) when installed, else the Windows PowerShell 5.1
 * that every supported build ships. Both are driven with the same argv (see
 * `agents-windows.ts`), which is kept 5.1-compatible on purpose.
 */
export function resolvePowerShell(options: WindowsShellOptions = {}): string {
  const env = options.env ?? process.env;
  const exists = options.exists ?? isPresent;
  const programFiles = env.ProgramFiles ?? "C:\Program Files";
  const candidates = [join(programFiles, "PowerShell", "7", "pwsh.exe")];
  if (env.LOCALAPPDATA) {
    candidates.push(join(env.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe"));
  }
  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  const systemRoot = env.SystemRoot ?? env.windir ?? "C:\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * `/mnt/c/Users/x` → `C:\Users\x`. Any other POSIX path (a WSL `/home/...`
 * from a workspace saved before this change) has no Windows equivalent and
 * yields null.
 */
export function legacyPosixToWindowsPath(path: string): string | null {
  const mounted = WSL_MOUNT.exec(path);
  if (mounted) {
    const rest = (mounted[2] ?? "").replaceAll("/", "\\");
    return `${mounted[1].toUpperCase()}:\\${rest}`;
  }
  return null;
}

/**
 * Directory a pane may actually be started in. CreateProcess fails outright
 * on a working directory that is not there, and a workspace can carry a stale
 * or pre-migration path — the pane then opens in the fallback rather than
 * refusing to open at all.
 */
export function resolveWindowsCwd(
  cwd: string,
  fallback: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): string {
  const trimmed = cwd.trim();
  const translated = trimmed.startsWith("/")
    ? legacyPosixToWindowsPath(trimmed)
    : trimmed.replaceAll("/", "\\");
  const isWindowsAbsolute =
    translated !== null
    && (WINDOWS_DRIVE.test(translated) || translated.startsWith("\\\\"));
  if (!translated || !isWindowsAbsolute) {
    return fallback;
  }
  return exists(translated) ? translated : fallback;
}

/**
 * Kills a pane's whole process tree. node-pty closing the ConPTY takes the
 * shell down, but an agent that detached from the console — or one busy
 * trapping the close event — would keep running without this. Best effort:
 * closing a terminal must never surface an error.
 */
export function killWindowsProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      resolve();
      return;
    }
    execFile(
      "taskkill.exe",
      ["/T", "/F", "/PID", String(pid)],
      { windowsHide: true, timeout: 5_000 },
      () => resolve(),
    );
  });
}
