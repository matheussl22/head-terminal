const STAGE_LABELS: Record<string, string> = {
  "js.main.begin": "Carregando interface",
  "js.react.root_created": "Preparando React",
  "js.react.render_committed": "Renderizando",
  "js.bootstrap.begin": "Iniciando sessões",
  "js.bootstrap.cwd_ok": "Diretório padrão carregado",
  "js.bootstrap.workspace_ok": "Sessões restauradas",
  "js.bootstrap.complete": "Finalizando inicialização",
  "js.app_shell.visible": "Montando painel principal",
  "js.session.spawn_scheduled": "Preparando terminal",
  "js.terminal.dom_opened": "Abrindo terminal",
  "js.terminal.fit_ok": "Ajustando terminal",
  "js.pty.spawn_begin": "Iniciando agent",
  "js.pty.spawn_ok": "Agent em execução",
  "js.pty.first_byte": "Recebendo saída",
  "ui.ready": "Pronto",
  "watchdog.3s": "Verificando inicialização",
};

export function humanizeCheckpoint(stage: string | null): string {
  if (!stage) {
    return "Iniciando…";
  }
  return STAGE_LABELS[stage] ?? stage;
}
