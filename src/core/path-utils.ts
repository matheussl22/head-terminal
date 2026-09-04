export function truncatePathMiddle(path: string, maxLength = 28): string {
  if (path.length <= maxLength) {
    return path;
  }

  const headLength = Math.ceil((maxLength - 1) / 2);
  const tailLength = Math.floor((maxLength - 1) / 2);

  return `${path.slice(0, headLength)}…${path.slice(-tailLength)}`;
}

const WINDOWS_DRIVE = /^[A-Za-z]:(?:[\\/]|$)/u;
const WSL_MOUNT = /^\/mnt\/([a-z])(?:\/(.*))?$/iu;

/** `C:\x`, `C:/x` or a UNC `\\server\share`. */
export function isWindowsPath(path: string): boolean {
  return WINDOWS_DRIVE.test(path) || path.startsWith("\\\\");
}

/** Last segment of a path spelled with either separator. */
export function basenamePath(path: string, fallback = ""): string {
  const normalized = path.replace(/[\\/]+$/u, "");
  const parts = normalized.split(/[\\/]/u);
  return parts[parts.length - 1] || fallback;
}

/** Joins with the separator the base already uses, so a Windows base stays Windows. */
export function joinPath(base: string, ...segments: string[]): string {
  const separator = isWindowsPath(base) ? "\\" : "/";
  const root = base.replace(/[\\/]+$/u, "");
  return [root, ...segments].join(separator);
}

/**
 * `/mnt/c/Users/x` → `C:\Users\x`. Workspaces saved while panes ran inside
 * WSL carry these; anything else POSIX (`/home/...`) has no Windows
 * equivalent and yields null.
 */
export function legacyPosixToWindowsPath(path: string): string | null {
  const mounted = WSL_MOUNT.exec(path);
  if (!mounted) {
    return null;
  }
  const rest = (mounted[2] ?? "").replaceAll("/", "\\");
  return `${mounted[1].toUpperCase()}:\\${rest}`;
}
