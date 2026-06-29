import { getShellPath } from "../core/agent-launcher";

export interface AgentProfile {
  id: string;
  label: string;
  command: string;
  args: string[];
}

function cursorWithFallbackArgs(): string[] {
  return ["-l", "-c", "cursor agent; exec zsh -l"];
}

function claudeWithFallbackArgs(): string[] {
  return ["-l", "-c", "claude; exec zsh -l"];
}

function codexWithFallbackArgs(): string[] {
  return ["-l", "-c", "codex; exec zsh -l"];
}

function antigravityWithFallbackArgs(): string[] {
  return ["-l", "-c", "agy; exec zsh -l"];
}

export function buildAgentProfiles(): Record<string, AgentProfile> {
  const shell = getShellPath();

  return {
    antigravity: {
      id: "antigravity",
      label: "Antigravity",
      command: shell,
      args: antigravityWithFallbackArgs(),
    },
    cursor: {
      id: "cursor",
      label: "Cursor Agent",
      command: shell,
      args: cursorWithFallbackArgs(),
    },
    claude: {
      id: "claude",
      label: "Claude Code",
      command: shell,
      args: claudeWithFallbackArgs(),
    },
    codex: {
      id: "codex",
      label: "Codex CLI",
      command: shell,
      args: codexWithFallbackArgs(),
    },
    shell: {
      id: "shell",
      label: "Shell",
      command: shell,
      args: ["-l"],
    },
  };
}

export const DEFAULT_AGENT_PROFILE_ID = "cursor";

export function getAgentProfile(profileId: string): AgentProfile {
  const profiles = buildAgentProfiles();
  return profiles[profileId] ?? profiles[DEFAULT_AGENT_PROFILE_ID];
}
