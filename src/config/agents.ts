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

// Private OSC emitted when a `--resume` never got off the ground and the
// pane started a fresh conversation instead. Payload:
// "resume-failed:<exit code>".
export const AGENT_RESUME_FALLBACK_OSC = 7771;

/** How long a resumed agent has to live before its failure counts as a real
 * session ending rather than a resume that never started. */
const RESUME_FAILURE_WINDOW_SECONDS = 5;

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

/**
 * `--resume <id>` dies immediately when the CLI won't take the id — the
 * transcript was deleted, belongs to another account, or the CLI rejects it
 * for reasons of its own ("No conversation found with session ID"). Without
 * this the pane lands on the bare shell fallback and the user has to notice
 * and restart it by hand; instead it starts a fresh agent and says so.
 *
 * A resumed session that ran for a while and then exited non-zero is a real
 * session ending, so it keeps falling through to the shell as before.
 */
function withResumeFallback(resumeCmd: string, freshCmd: string): string {
  return (
    `__ht_resume_start=$SECONDS; ${resumeCmd}; __ht_resume_code=$?; `
    + `if [ $__ht_resume_code -ne 0 ] `
    + `&& [ $((SECONDS - __ht_resume_start)) -lt ${RESUME_FAILURE_WINDOW_SECONDS} ]; then `
    + `printf "\\033]${AGENT_RESUME_FALLBACK_OSC};resume-failed:%s\\007" $__ht_resume_code; `
    + `${freshCmd}; fi`
  );
}

function withShellFallback(agentCmd: string): string[] {
  return [
    "-l",
    "-c",
    `${agentCmd}; printf "\\033]${AGENT_FALLBACK_OSC};agent-exited:%s\\007" $?; exec zsh -l`,
  ];
}

/**
 * The official installer puts the CLI on the PATH as `cursor-agent`, while
 * older setups reach it as the `agent` subcommand of `cursor`. Neither name is
 * safe to hardcode, so the pane picks whichever the shell can actually find —
 * otherwise the pane opens straight into `command not found`.
 */
const CURSOR_SHIM =
  'ht_cursor() { if command -v cursor-agent >/dev/null 2>&1; '
  + 'then cursor-agent "$@"; '
  + 'elif command -v cursor-agent.cmd >/dev/null 2>&1; '
  + 'then cursor-agent.cmd "$@"; '
  + 'elif command -v cursor-agent.exe >/dev/null 2>&1; '
  + 'then cursor-agent.exe "$@"; '
  + 'else cursor agent "$@"; fi; }; ';

function cursorWithFallbackArgs(
  continueConversation: boolean,
  resumeSessionId?: string,
): string[] {
  const id = sanitizeResumeSessionId(resumeSessionId);
  const command = id
    ? withResumeFallback(`ht_cursor --resume ${id}`, "ht_cursor")
    : continueConversation
      ? "ht_cursor --continue"
      : "ht_cursor";
  return withShellFallback(`${CURSOR_SHIM}${command}`);
}

function claudeWithFallbackArgs(
  continueConversation: boolean,
  resumeSessionId?: string,
): string[] {
  const id = sanitizeResumeSessionId(resumeSessionId);
  return withShellFallback(
    id
      ? withResumeFallback(`claude --resume ${id}`, "claude")
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
  return withShellFallback(
    id ? withResumeFallback(`codex resume ${id}`, "codex") : "codex",
  );
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
