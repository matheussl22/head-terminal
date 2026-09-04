import type { PlatformInfo } from "../../electron/types/api";
import { logError } from "./logger";

/**
 * Cached copy of `window.headTerminal.system.getPlatform()`. Fetched once at
 * boot (see main.tsx) so that by the time the first pane spawns a terminal —
 * after session-store hydration, itself async — the host platform is already
 * known to `createConfiguredTerminal` (`windowsPty`) and to the agent profile
 * builders (PowerShell vs zsh). `null` until the fetch resolves; callers
 * treat that the same as "unknown".
 */
let cached: PlatformInfo | null = null;
let pending: Promise<PlatformInfo | null> | null = null;

export function initPlatformInfo(): void {
  if (pending) {
    return;
  }
  pending = window.headTerminal.system
    .getPlatform()
    .then((info) => {
      cached = info;
      return info;
    })
    .catch((error) => {
      logError("platform-info.fetch_failed", error);
      return null;
    });
}

export function getCachedPlatformInfo(): PlatformInfo | null {
  return cached;
}

/** Resolves once the fetch settles; `null` when it failed or never started. */
export function whenPlatformInfo(): Promise<PlatformInfo | null> {
  return pending ?? Promise.resolve(cached);
}

/** True only once the host is known to be Windows. Panes there run natively. */
export function isWindowsHost(): boolean {
  return cached?.platform === "win32";
}

/** Test seam. */
export function setCachedPlatformInfoForTests(info: PlatformInfo | null): void {
  cached = info;
  pending = info ? Promise.resolve(info) : null;
}
