/**
 * A lifecycle event an agent CLI reported about itself, routed to the pane
 * that runs it. Today only Claude Code reports these (HTTP hooks injected per
 * pane with `--settings`, see electron/services/agent-hook-server.ts); the
 * payload is trimmed in the main process to what the status needs.
 */
export interface AgentHookEvent {
  paneId: string;
  source: "claude";
  /** `hook_event_name`: UserPromptSubmit, PreToolUse, PostToolUse,
   * PostToolUseFailure, PermissionRequest, Notification, Stop, StopFailure,
   * Elicitation, ElicitationResult, SubagentStop, SessionEnd… */
  event: string;
  /** Notification only: permission_prompt, idle_prompt, elicitation_dialog,
   * elicitation_url_dialog, agent_needs_input, auth_success… */
  notificationType?: string;
  /** PreToolUse / PermissionRequest / PostToolUse: the tool involved. */
  toolName?: string;
  /** Present when the event comes from a subagent. Claude fires a
   * SubagentStop with an empty agent_type after every turn (its internal
   * prompt-suggestion agent) — that one says nothing about the pane. */
  agentType?: string;
  /** StopFailure: rate_limit, overloaded, authentication_failed… */
  error?: string;
  /** Claude's `session_id`: the conversation the event belongs to. The pane
   * id says which pane's settings file the session was started with; a
   * session dispatched from the agent view can still carry another pane's
   * file, so a pane that knows its own conversation can drop the rest. */
  sessionId?: string;
  /** Main-process clock when the request arrived. */
  receivedAt: number;
}

/** Environment variable the pane id is exported in. No longer what routes
 * the hooks — a Claude background session runs under a supervisor that
 * carries the env of whichever pane started it first — but still accepted
 * on spawn and scrubbed at startup, so an id never leaks into another pane. */
export const AGENT_HOOK_PANE_ENV = "HT_PANE_ID";

/** Header the hook sends the pane id in, written literally into the pane's
 * own settings file. */
export const AGENT_HOOK_PANE_HEADER = "x-ht-pane";

/** Pane ids travel through a file name and an HTTP header. */
export const AGENT_HOOK_PANE_ID = /^[A-Za-z0-9_-]{1,64}$/;
