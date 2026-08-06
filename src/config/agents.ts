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

// Session ids picked from the resume dropdown are always claude/codex/cursor
// UUIDs (see electron/services/agent-sessions-service.ts) or codex's rollout
// id — this guards the shell interpolation below against anything else that
// might end up here, defense in depth rather than trusting the IPC boundary.
const RESUMABLE_SESSION_ID = /^[0-9a-f-]{8,64}$/i;

function sanitizeResumeSessionId(resumeSessionId?: string): string | undefined {
  return resumeSessionId && RESUMABLE_SESSION_ID.test(resumeSessionId)
    ? resumeSessionId
    : undefined;
}

function withShellFallback(agentCmd: string): string[] {
  return [
    "-l",
    "-c",
    `${agentCmd}; printf "\\033]${AGENT_FALLBACK_OSC};agent-exited:%s\\007" $?; exec zsh -l`,
  ];
}

function cursorWithFallbackArgs(
  continueConversation: boolean,
  resumeSessionId?: string,
): string[] {
  const id = sanitizeResumeSessionId(resumeSessionId);
  return withShellFallback(
    id
      ? `cursor agent --resume ${id}`
      : continueConversation
        ? "cursor agent --continue"
        : "cursor agent",
  );
}

function claudeWithFallbackArgs(
  continueConversation: boolean,
  resumeSessionId?: string,
): string[] {
  const id = sanitizeResumeSessionId(resumeSessionId);
  return withShellFallback(
    id
      ? `claude --resume ${id}`
      : continueConversation
        ? "claude --continue"
        : "claude",
  );
}

function codexWithFallbackArgs(resumeSessionId?: string): string[] {
  // ponytail: codex CLI not installed locally, no confirmed --continue
  // equivalent — always spawns fresh until that's verified. --resume <id>
  // is confirmed (`codex resume <id>`), so that path is wired regardless.
  const id = sanitizeResumeSessionId(resumeSessionId);
  return withShellFallback(id ? `codex resume ${id}` : "codex");
}

function antigravityWithFallbackArgs(): string[] {
  return withShellFallback("agy");
}

export interface AgentProfileOptions {
  continueConversation?: boolean;
  /** Resume this exact CLI session instead of --continue/fresh. Takes
   * precedence over `continueConversation` when both are set. */
  resumeSessionId?: string;
}

export function buildAgentProfiles(
  options: AgentProfileOptions = {},
): Record<string, AgentProfile> {
  const shell = getShellPath();
  const continueConversation = options.continueConversation ?? false;
  const { resumeSessionId } = options;

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
      args: cursorWithFallbackArgs(continueConversation, resumeSessionId),
    },
    claude: {
      id: "claude",
      label: "Claude Code",
      command: shell,
      args: claudeWithFallbackArgs(continueConversation, resumeSessionId),
    },
    codex: {
      id: "codex",
      label: "Codex CLI",
      command: shell,
      args: codexWithFallbackArgs(resumeSessionId),
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
