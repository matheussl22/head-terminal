import { getShellPath } from "../core/agent-launcher";

export interface AgentProfile {
  id: string;
  label: string;
  command: string;
  args: string[];
}

// Private OSC emitted between the agent dying and the shell fallback taking
// over, so the UI can tell "agent crashed, shell active" apart from normal
// output. Payload: "agent-exited:<exit code>".
export const AGENT_FALLBACK_OSC = 7770;

function withShellFallback(agentCmd: string): string[] {
  return [
    "-l",
    "-c",
    `${agentCmd}; printf "\\033]${AGENT_FALLBACK_OSC};agent-exited:%s\\007" $?; exec zsh -l`,
  ];
}

function cursorWithFallbackArgs(continueConversation: boolean): string[] {
  return withShellFallback(
    continueConversation ? "cursor agent --continue" : "cursor agent",
  );
}

function claudeWithFallbackArgs(continueConversation: boolean): string[] {
  return withShellFallback(continueConversation ? "claude --continue" : "claude");
}

function codexWithFallbackArgs(): string[] {
  // ponytail: codex CLI not installed locally, no confirmed --continue
  // equivalent — always spawns fresh until that's verified.
  return withShellFallback("codex");
}

function antigravityWithFallbackArgs(): string[] {
  return withShellFallback("agy");
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
