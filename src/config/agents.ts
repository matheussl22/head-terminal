import { getShellPath } from "../core/agent-launcher";

export interface AgentProfile {
  id: string;
  label: string;
  command: string;
  args: string[];
}

function cursorWithFallbackArgs(continueConversation: boolean): string[] {
  const cmd = continueConversation ? "cursor agent --continue" : "cursor agent";
  return ["-l", "-c", `${cmd}; exec zsh -l`];
}

function claudeWithFallbackArgs(continueConversation: boolean): string[] {
  const cmd = continueConversation ? "claude --continue" : "claude";
  return ["-l", "-c", `${cmd}; exec zsh -l`];
}

function codexWithFallbackArgs(): string[] {
  // ponytail: codex CLI not installed locally, no confirmed --continue
  // equivalent — always spawns fresh until that's verified.
  return ["-l", "-c", "codex; exec zsh -l"];
}

export interface AgentProfileOptions {
  continueConversation?: boolean;
}

export function buildAgentProfiles(
  options: AgentProfileOptions = {},
): Record<string, AgentProfile> {
  const shell = getShellPath();
  const continueConversation = options.continueConversation ?? false;

  return {
    cursor: {
      id: "cursor",
      label: "Cursor Agent",
      command: shell,
      args: cursorWithFallbackArgs(continueConversation),
    },
    claude: {
      id: "claude",
      label: "Claude Code",
      command: shell,
      args: claudeWithFallbackArgs(continueConversation),
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

export function getAgentProfile(
  profileId: string,
  options?: AgentProfileOptions,
): AgentProfile {
  const profiles = buildAgentProfiles(options);
  return profiles[profileId] ?? profiles[DEFAULT_AGENT_PROFILE_ID];
}
