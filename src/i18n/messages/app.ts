// Text for the app shell: window title, toolbar, command palette, session
// context menu, resource meter, boot screen, render-error screen and the
// shared confirm dialog. `ptBR` is the source; `en` must have the very same
// keys (the type enforces it). Text with a value in it is a function.
const ptBR = {
  bootFailed: "Falha ao iniciar o Head Terminal",
  sessionsLoadFailed: "Não foi possível carregar as sessões.",
  windowTitle: (status: string, base: string) => `● ${status} — ${base}`,
  closeWhileWorking: {
    title: "Fechar Head Terminal",
    message: (count: number) => `${count} agent(s) executando ou aguardando você.`,
    detail: "Fechar mesmo assim? Os processos em execução serão encerrados.",
    confirm: "Fechar",
    cancel: "Cancelar",
  },
  closeSaveFailed: {
    title: "Falha ao salvar workspace",
    message: "Não foi possível persistir o estado mais recente.",
    detail: "Deseja fechar mesmo assim?",
    confirm: "Fechar sem salvar",
    cancel: "Cancelar",
  },
  toolbar: {
    waiting: (count: number) => `${count} aguardando`,
    waitingHint: (count: number) =>
      `${count} ${count === 1 ? "terminal espera" : "terminais esperam"} sua resposta — clique para ir ao primeiro`,
    done: (count: number) => `${count} ${count === 1 ? "concluído" : "concluídos"}`,
    doneHint: (count: number) =>
      `${count} ${count === 1 ? "terminal terminou" : "terminais terminaram"} enquanto você não estava olhando — clique para ir ao primeiro`,
    working: (count: number) => `${count} executando`,
    workingHint: (count: number) =>
      `${count} ${count === 1 ? "terminal executando" : "terminais executando"}`,
    commandPaletteHint: (shortcut: string) => `Paleta de comandos (${shortcut})`,
    commandPalette: "Paleta de comandos",
    commands: "Comandos",
    settings: "Configurações",
  },
  palette: {
    ariaLabel: "Paleta de comandos",
    placeholder: "Digite um comando…",
    empty: "Nenhum comando encontrado",
  },
  sessionMenu: {
    rename: "Renomear",
    pin: "Fixar",
    unpin: "Desafixar",
    changeFolder: "Alterar pasta…",
    isolate: "Isolar em worktree…",
    duplicate: "Duplicar",
    hibernate: "Hibernar agora",
    close: "Fechar sessão",
  },
  hibernate: {
    confirmTitle: "Hibernar a sessão?",
    confirmDetail:
      "Hibernar encerra os processos da sessão. Os agents retomam a conversa ao reabrir; o que estiver rodando agora é interrompido.",
    confirm: "Hibernar mesmo assim",
    cancel: "Cancelar",
    placeholderTitle: "Sessão hibernada",
    placeholderBody:
      "Os terminais desta sessão foram encerrados para liberar memória. Ao retomar, cada agent volta na mesma conversa.",
    resume: "Retomar sessão",
    blocked: {
      busy: (pane: number) => `O terminal ${pane} está trabalhando ou esperando você.`,
      processes: (pane: number, what: string) =>
        `O terminal ${pane} ainda tem processos rodando${what ? ` (${what})` : ""}.`,
      unanchored: (pane: number) =>
        `A conversa do terminal ${pane} não foi identificada: ao retomar, ele começa uma nova.`,
      profile: (pane: number) => `O terminal ${pane} não consegue retomar de onde parou.`,
      watched: (pane: number) => `O terminal ${pane} está aberto no celular ou gravando voz.`,
      notSpawned: "A sessão já está parada.",
      recent: "A sessão foi usada há pouco.",
    },
  },
  remote: {
    paneGone: "Esse terminal não existe mais.",
    sessionGone: "Essa sessão não existe mais.",
    paneAsleep: "A sessão está hibernada — acorde-a primeiro.",
    paneNotRunning: "O terminal não está rodando agora.",
    unknownCommand: "Comando desconhecido.",
  },
  meter: {
    cpu: "CPU",
    memory: "Memória",
    disk: (label: string) => `Disco ${label}`,
  },
  boot: {
    starting: "Iniciando sessões…",
    slow: "A inicialização está demorando…",
    retry: "Tentar novamente",
    copyDiagnostic: "Copiar diagnóstico",
    diagnosticCopied: "Diagnóstico copiado",
    exportDiagnostic: "Exportar diagnóstico",
    savedToLogs: "Salvo em logs/",
  },
  renderError: {
    title: "Head Terminal — erro de renderização",
    retry: "Tentar novamente",
    components: "Componentes:",
  },
  confirmDialog: {
    cancel: "Cancelar",
    confirm: "OK",
  },
};

const en: typeof ptBR = {
  bootFailed: "Head Terminal failed to start",
  sessionsLoadFailed: "Couldn't load the sessions.",
  windowTitle: (status, base) => `● ${status} — ${base}`,
  closeWhileWorking: {
    title: "Close Head Terminal",
    message: (count) =>
      count === 1
        ? "1 agent is running or waiting for you."
        : `${count} agents are running or waiting for you.`,
    detail: "Close anyway? Running processes will be terminated.",
    confirm: "Close",
    cancel: "Cancel",
  },
  closeSaveFailed: {
    title: "Couldn't save the workspace",
    message: "The latest state could not be saved.",
    detail: "Close anyway?",
    confirm: "Close without saving",
    cancel: "Cancel",
  },
  toolbar: {
    waiting: (count) => `${count} waiting`,
    waitingHint: (count) =>
      count === 1
        ? "1 terminal is waiting for your answer — click to go to it"
        : `${count} terminals are waiting for your answer — click to go to the first`,
    done: (count) => `${count} done`,
    doneHint: (count) =>
      count === 1
        ? "1 terminal finished while you weren't looking — click to go to it"
        : `${count} terminals finished while you weren't looking — click to go to the first`,
    working: (count) => `${count} running`,
    workingHint: (count) => (count === 1 ? "1 terminal running" : `${count} terminals running`),
    commandPaletteHint: (shortcut) => `Command palette (${shortcut})`,
    commandPalette: "Command palette",
    commands: "Commands",
    settings: "Settings",
  },
  palette: {
    ariaLabel: "Command palette",
    placeholder: "Type a command…",
    empty: "No commands found",
  },
  sessionMenu: {
    rename: "Rename",
    pin: "Pin",
    unpin: "Unpin",
    changeFolder: "Change folder…",
    isolate: "Isolate in worktree…",
    duplicate: "Duplicate",
    hibernate: "Hibernate now",
    close: "Close session",
  },
  hibernate: {
    confirmTitle: "Hibernate the session?",
    confirmDetail:
      "Hibernating stops the session's processes. Agents resume their conversation when reopened; whatever is running now is interrupted.",
    confirm: "Hibernate anyway",
    cancel: "Cancel",
    placeholderTitle: "Session hibernated",
    placeholderBody:
      "This session's terminals were stopped to free memory. When resumed, each agent comes back on the same conversation.",
    resume: "Resume session",
    blocked: {
      busy: (pane) => `Terminal ${pane} is working or waiting for you.`,
      processes: (pane, what) =>
        `Terminal ${pane} still has processes running${what ? ` (${what})` : ""}.`,
      unanchored: (pane) =>
        `Terminal ${pane}'s conversation was never identified: it would start a new one.`,
      profile: (pane) => `Terminal ${pane} cannot resume where it left off.`,
      watched: (pane) => `Terminal ${pane} is open on a phone or recording voice.`,
      notSpawned: "The session is already stopped.",
      recent: "The session was used a moment ago.",
    },
  },
  remote: {
    paneGone: "That terminal no longer exists.",
    sessionGone: "That session no longer exists.",
    paneAsleep: "The session is hibernated — wake it first.",
    paneNotRunning: "The terminal is not running right now.",
    unknownCommand: "Unknown command.",
  },
  meter: {
    cpu: "CPU",
    memory: "Memory",
    disk: (label) => `Disk ${label}`,
  },
  boot: {
    starting: "Starting sessions…",
    slow: "Startup is taking a while…",
    retry: "Try again",
    copyDiagnostic: "Copy diagnostics",
    diagnosticCopied: "Diagnostics copied",
    exportDiagnostic: "Export diagnostics",
    savedToLogs: "Saved to logs/",
  },
  renderError: {
    title: "Head Terminal — rendering error",
    retry: "Try again",
    components: "Components:",
  },
  confirmDialog: {
    cancel: "Cancel",
    confirm: "OK",
  },
};

export const app = { "pt-BR": ptBR, en };
