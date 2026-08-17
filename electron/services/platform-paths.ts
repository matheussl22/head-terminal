import { homedir } from "node:os";
import { join } from "node:path";

export interface PlatformPathEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

function currentEnvironment(): PlatformPathEnvironment {
  return { platform: process.platform, env: process.env, home: homedir() };
}

/**
 * Directory where a Windows application keeps per-user, machine-local state.
 * `%LOCALAPPDATA%` is normally set; the literal path is the documented
 * fallback for the rare service context where it is not.
 */
export function localAppData(
  environment: PlatformPathEnvironment = currentEnvironment(),
): string {
  const configured = environment.env.LOCALAPPDATA?.trim();
  return configured || join(environment.home, "AppData", "Local");
}

/**
 * Root of Head Terminal's own data directory, per platform convention.
 * macOS keeps the historical `~/.head-terminal` layout.
 */
export function appDataRoot(
  environment: PlatformPathEnvironment = currentEnvironment(),
): string {
  switch (environment.platform) {
    case "linux":
      return join(environment.home, ".local", "share", "head-terminal");
    case "win32":
      return join(localAppData(environment), "head-terminal");
    default:
      return join(environment.home, ".head-terminal");
  }
}
