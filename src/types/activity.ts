export type PaneActivity =
  | "starting"
  | "idle"
  | "working"
  | "waiting_input"
  | "error"
  | "exited";

export const ACTIVITY_PRIORITY: Record<PaneActivity, number> = {
  error: 6,
  working: 5,
  waiting_input: 4,
  starting: 3,
  idle: 2,
  exited: 1,
};

export const ACTIVITY_LABEL: Record<PaneActivity, string> = {
  starting: "Iniciando",
  idle: "Ativo",
  working: "Executando",
  waiting_input: "Aguardando",
  error: "Erro",
  exited: "Encerrado",
};
