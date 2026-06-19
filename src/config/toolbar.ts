export const CLEAR_SHORTCUT = "Ctrl+Shift+L";
export const HARD_CLEAR_SHORTCUT = "Ctrl+Shift+Alt+L";
export const COMMAND_PALETTE_SHORTCUT = "Ctrl+Shift+P";

export interface ToolbarCommand {
  id: string;
  label: string;
  command: string;
  shortcut?: string;
  description?: string;
}

export const AGENT_COMMANDS: ToolbarCommand[] = [
  {
    id: "clear",
    label: "Clear",
    command: "/clear",
    shortcut: CLEAR_SHORTCUT,
    description: "Limpa o contexto do agent (Shift+clique no botão reinicia o PTY)",
  },
  {
    id: "compact",
    label: "Compact",
    command: "/compact",
    description: "Compacta o contexto do agent",
  },
  {
    id: "context",
    label: "Context",
    command: "/context",
    description: "Mostra o contexto atual do agent",
  },
  {
    id: "help",
    label: "Help",
    command: "/help",
    description: "Lista comandos disponíveis",
  },
];

export const PALETTE_ACTIONS: ToolbarCommand[] = [
  ...AGENT_COMMANDS,
  {
    id: "split-vertical",
    label: "Split vertical",
    command: "__split_vertical__",
    shortcut: "Ctrl+\\",
    description: "Divide o terminal ativo verticalmente",
  },
  {
    id: "split-horizontal",
    label: "Split horizontal",
    command: "__split_horizontal__",
    shortcut: "Ctrl+Shift+\\",
    description: "Divide o terminal ativo horizontalmente",
  },
  {
    id: "rename-session",
    label: "Renomear sessão",
    command: "__rename_session__",
    shortcut: "F2",
    description: "Renomeia a sessão ativa",
  },
];
