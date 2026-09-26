export type PaneActivity =
  | "starting"
  | "idle"
  | "working"
  | "waiting_input"
  | "agent_fallback"
  | "error"
  | "exited";

/**
 * Why a pane is in "waiting_input". That state only ever means the agent is
 * blocked on the user — an agent that simply finished its turn is "idle".
 * - approval: a tool/command permission dialog is open.
 * - question: the agent asked the user something (multiple choice, plan
 *   approval, MCP elicitation).
 * - dialog: some other blocking screen (workspace trust, update prompt…).
 */
export type BlockedReason = "approval" | "question" | "dialog";

/** What a "waiting_input" pane is blocked on. */
export interface PaneBlock {
  reason: BlockedReason;
  /** Display only: the tool of a permission request ("Bash", "Write"), or
   * what the agent asked about. */
  detail?: string;
}

/**
 * Which pane speaks for a session when its panes disagree. Anything that
 * needs the user outranks work: a pane blocked on an approval must never hide
 * behind a sibling that is still running.
 */
export const ACTIVITY_PRIORITY: Record<PaneActivity, number> = {
  waiting_input: 7,
  error: 6,
  agent_fallback: 5,
  working: 4,
  starting: 3,
  idle: 2,
  exited: 1,
};

// Estados em que a sessão está bloqueada esperando o usuário.
export const NEEDS_ATTENTION: ReadonlySet<PaneActivity> = new Set([
  "waiting_input",
  "error",
  "agent_fallback",
]);

export const ACTIVITY_LABEL: Record<PaneActivity, string> = {
  starting: "Iniciando",
  idle: "Pronto",
  working: "Executando",
  waiting_input: "Aguardando",
  agent_fallback: "Shell",
  error: "Erro",
  exited: "Encerrado",
};

export const BLOCKED_REASON_LABEL: Record<BlockedReason, string> = {
  approval: "pede aprovação",
  question: "fez uma pergunta",
  dialog: "espera uma confirmação",
};
