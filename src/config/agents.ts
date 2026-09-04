import { getShellPath } from "../core/agent-launcher";
import { isWindowsHost } from "../core/platform-info";
import {
  buildPosixAgentProfiles,
  quoteGgufPath as quotePosixGgufPath,
  sanitizeGgufPath as sanitizePosixGgufPath,
} from "./agents-posix";
import {
  buildWindowsAgentProfiles,
  quoteWindowsGgufPath,
  sanitizeWindowsGgufPath,
} from "./agents-windows";
import {
  DEFAULT_AGENT_PROFILE_ID,
  type AgentProfile,
  type AgentProfileOptions,
} from "./agents-shared";

/**
 * The agent profile catalog. Which shell a profile targets is the host's
 * business, decided here once: PowerShell on Windows, a login zsh elsewhere.
 * Nothing that consumes a profile knows the difference.
 */

export * from "./agents-shared";

export function buildAgentProfiles(
  options: AgentProfileOptions = {},
): Record<string, AgentProfile> {
  return isWindowsHost()
    ? buildWindowsAgentProfiles(options)
    : buildPosixAgentProfiles(options, getShellPath());
}

export function getAgentProfile(
  profileId: string,
  options?: AgentProfileOptions,
): AgentProfile {
  const profiles = buildAgentProfiles(options);
  return profiles[profileId] ?? profiles[DEFAULT_AGENT_PROFILE_ID];
}

/** GGUF path as the pane's shell will need it — see the per-shell builders. */
export function sanitizeGgufPath(path?: string): string | undefined {
  return isWindowsHost() ? sanitizeWindowsGgufPath(path) : sanitizePosixGgufPath(path);
}

export function quoteGgufPath(path: string): string {
  return isWindowsHost() ? quoteWindowsGgufPath(path) : quotePosixGgufPath(path);
}
