export type PaneActivity =
  | "starting"
  | "idle"
  | "working"
  | "waiting_input"
  | "agent_fallback"
  | "error"
  | "exited";

export const ACTIVITY_PRIORITY: Record<PaneActivity, number> = {
  error: 7,
  agent_fallback: 6,
  working: 5,
  waiting_input: 4,
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
