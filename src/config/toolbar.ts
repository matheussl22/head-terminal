export const CLEAR_SHORTCUT = "Ctrl+Shift+L";
export const HARD_CLEAR_SHORTCUT = "Ctrl+Shift+Alt+L";
export const COMMAND_PALETTE_SHORTCUT = "Ctrl+Shift+P";
export const VOICE_SHORTCUT = "F9";

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

export const AGENT_INSTRUCTION_ACTION: ToolbarCommand = {
  id: "agent-instructions",
  label: "Regras do projeto",
  command: "__agent_instructions__",
  description:
    "Referencia AGENTS.md, CLAUDE.md ou GEMINI.md no agent ativo (@mention)",
};

export const PALETTE_ACTIONS: ToolbarCommand[] = [
  ...AGENT_COMMANDS,
  AGENT_INSTRUCTION_ACTION,
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
    id: "close-pane",
    label: "Fechar terminal",
    command: "__close_pane__",
    shortcut: "Ctrl+Shift+W",
    description: "Fecha o terminal ativo (requer mais de um terminal na sessão)",
  },
  {
    id: "export-diagnostic",
    label: "Exportar diagnóstico de inicialização",
    command: "__export_diagnostic__",
    description: "Salva logs de boot e estado da UI em ~/.local/share/head-terminal/logs/",
  },
  {
    id: "rename-session",
    label: "Renomear sessão",
    command: "__rename_session__",
    shortcut: "F2",
    description: "Renomeia a sessão ativa",
  },
  {
    id: "settings",
    label: "Configurações",
    command: "__settings__",
    description: "Configura a chave da API OpenAI para transcrição de voz",
  },
  {
    id: "voice-input",
    label: "Gravar prompt por voz",
    command: "__voice_input__",
    shortcut: VOICE_SHORTCUT,
    description: "Inicia ou para a gravação de voz no terminal ativo",
  },
];
