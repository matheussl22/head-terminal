// Text for the Electron main process — menus, native dialogs and the errors
// that reach the UI. `ptBR` is the source; `en` must have the very same keys
// (the type enforces it). Text with a value in it is a function. Main learns
// its language once the app is ready, so it reads these where it throws or
// shows them, never at import time. What the voice model and the agents are
// told stays out of here: it is behaviour, written in Portuguese on purpose.
const ptBR = {
  menu: {
    view: "Visualizar",
  },
  dialog: {
    confirm: "Confirmar",
    cancel: "Cancelar",
    allFiles: "Todos",
  },
  paths: {
    invalid: "Caminho inválido",
    invalidProfile: "Caminho de perfil inválido",
    invalidProfilesRoot: "Diretório de perfis inválido",
    invalidDirectory: "Diretório inválido",
  },
  git: {
    notARepository: "O diretório não é um repositório git",
    notAWorktree: "O diretório não é um worktree git",
    mainRepository: "Este diretório é o repositório principal, não um worktree",
  },
  mcp: {
    cliNotFound: (binary: string) => `CLI '${binary}' não encontrada`,
    queryFailed: (binary: string) => `Falha ao consultar '${binary}'`,
  },
  workspace: {
    invalid: "Workspace inválido",
  },
  agentSessions: {
    untitled: (when: string) => `Sessão de ${when}`,
  },
  install: {
    downloadFailed: (url: string, status: number) => `Falha ao baixar ${url} (${status})`,
  },
  openAi: {
    missingApiKey: "Configure sua chave da OpenAI nas Configurações.",
    network: "Falha de rede ao contatar a OpenAI.",
    httpError: (status: number) => `Erro HTTP ${status}`,
    unreadableResponse: "Não foi possível interpretar a resposta da OpenAI.",
  },
  remote: {
    windowClosed: "A janela do Head Terminal não está aberta no computador.",
  },
  voice: {
    alreadyRecording: "Já existe uma gravação em andamento.",
    startFailed: (detail: string) => `Não foi possível iniciar a gravação: ${detail}`,
    notRecording: "Nenhuma gravação em andamento.",
    noAudioFile: "Arquivo de áudio não foi gerado.",
    tooShort: "Gravação muito curta ou sem áudio. Fale por pelo menos 1 segundo.",
    recorderTimeout: "A inicialização do gravador demorou demais.",
    emptyAudio: "Áudio vazio.",
    tooLong: "Gravação longa demais para transcrever.",
    transcriptionTimeout: "A transcrição demorou demais e foi cancelada.",
    transcriptionFailed: (detail: string) => `Falha na transcrição: ${detail}`,
  },
  brainstorm: {
    broadFolderWarning:
      "Este terminal está na pasta pessoal, não em um projeto. Diga por voz \"abre a pasta <nome>\" ou abra um terminal na pasta do projeto.",
    openTimeout: "A OpenAI demorou demais para abrir a conversa.",
    openFailed: (detail: string) => `Não foi possível abrir a conversa por voz: ${detail}`,
    noSdp: "A OpenAI não devolveu a resposta de conexão (SDP).",
    invalidAgentSessionId: "Id de conversa do agente inválido.",
    tooManyImages: (max: number) => `No máximo ${max} imagens por análise.`,
    notAnImage: (name: string) => `Anexo não é uma imagem: ${name}`,
    imageNotFound: (name: string) => `Imagem anexada não foi encontrada: ${name}`,
    windowsCliNotFound: (name: string) => `${name} não foi encontrado no PATH do Windows.`,
    unsafeWindowsArgs: (name: string) => `Argumentos inseguros para iniciar ${name} pelo cmd.exe.`,
    cursorNotFound: "cursor-agent não foi encontrado no PATH do Windows.",
    cursorNotInstalled: (base: string) => `Nenhuma versão do Cursor Agent instalada em ${base}.`,
    noClaudeProfile: "O terminal não informou o perfil Claude.",
    claudeProfileOutside: "Perfil Claude fora de ~/.head-terminal/claude-profiles.",
    folderNotFound: (cwd: string) => `Pasta do terminal não encontrada: ${cwd}`,
    alreadyRunning: "Essa análise já está em andamento.",
    startFailed: (agent: string, detail: string) => `Não foi possível iniciar o ${agent}: ${detail}`,
    timedOut: (agent: string, minutes: number) =>
      `O ${agent} passou de ${minutes} min e foi interrompido.`,
    replyTooLarge: (agent: string) => `A resposta do ${agent} ficou grande demais.`,
    cancelled: "Análise cancelada.",
    agentReportedError: "o agente reportou um erro",
    emptyReply: "resposta vazia",
    exitedWith: (code: number | null) => `saiu com código ${code ?? "desconhecido"}`,
    resumeFailed: "a conversa anterior não pôde ser retomada; recomeçando do zero",
    /** What the agent is doing, one short line per tool call. */
    steps: {
      reading: (file: string) => `lendo ${file}`,
      readingAFile: "lendo um arquivo",
      searchingFor: (pattern: string) => `buscando "${pattern}" no código`,
      searchingCode: "buscando no código",
      listing: (pattern: string) => `listando ${pattern}`,
      listingFiles: "listando arquivos",
      searchingWebFor: (query: string) => `pesquisando na web: ${query}`,
      searchingWeb: "pesquisando na web",
      opening: (url: string) => `abrindo ${url}`,
      openingAPage: "abrindo uma página",
      using: (tool: string) => `usando ${tool}`,
      running: (command: string) => `rodando ${command}`,
    },
  },
};

const en: typeof ptBR = {
  menu: {
    view: "View",
  },
  dialog: {
    confirm: "Confirm",
    cancel: "Cancel",
    allFiles: "All files",
  },
  paths: {
    invalid: "Invalid path",
    invalidProfile: "Invalid profile path",
    invalidProfilesRoot: "Invalid profiles folder",
    invalidDirectory: "Invalid folder",
  },
  git: {
    notARepository: "The folder is not a git repository",
    notAWorktree: "The folder is not a git worktree",
    mainRepository: "This folder is the main repository, not a worktree",
  },
  mcp: {
    cliNotFound: (binary) => `CLI '${binary}' not found`,
    queryFailed: (binary) => `Couldn't query '${binary}'`,
  },
  workspace: {
    invalid: "Invalid workspace",
  },
  agentSessions: {
    untitled: (when) => `Session from ${when}`,
  },
  install: {
    downloadFailed: (url, status) => `Couldn't download ${url} (${status})`,
  },
  openAi: {
    missingApiKey: "Set your OpenAI key in Settings.",
    network: "Network error reaching OpenAI.",
    httpError: (status) => `HTTP error ${status}`,
    unreadableResponse: "Couldn't read OpenAI's response.",
  },
  remote: {
    windowClosed: "The Head Terminal window is not open on the computer.",
  },
  voice: {
    alreadyRecording: "A recording is already in progress.",
    startFailed: (detail) => `Couldn't start recording: ${detail}`,
    notRecording: "No recording in progress.",
    noAudioFile: "No audio file was produced.",
    tooShort: "Recording too short or silent. Speak for at least 1 second.",
    recorderTimeout: "The recorder took too long to start.",
    emptyAudio: "Empty audio.",
    tooLong: "Recording too long to transcribe.",
    transcriptionTimeout: "Transcription took too long and was cancelled.",
    transcriptionFailed: (detail) => `Transcription failed: ${detail}`,
  },
  brainstorm: {
    broadFolderWarning:
      "This terminal is in your home folder, not in a project. Say \"open the folder <name>\" or open a terminal in the project folder.",
    openTimeout: "OpenAI took too long to open the conversation.",
    openFailed: (detail) => `Couldn't open the voice conversation: ${detail}`,
    noSdp: "OpenAI didn't return the connection answer (SDP).",
    invalidAgentSessionId: "Invalid agent conversation id.",
    tooManyImages: (max) => `At most ${max} images per analysis.`,
    notAnImage: (name) => `Attachment is not an image: ${name}`,
    imageNotFound: (name) => `Attached image not found: ${name}`,
    windowsCliNotFound: (name) => `${name} was not found on the Windows PATH.`,
    unsafeWindowsArgs: (name) => `Unsafe arguments to start ${name} through cmd.exe.`,
    cursorNotFound: "cursor-agent was not found on the Windows PATH.",
    cursorNotInstalled: (base) => `No Cursor Agent version installed in ${base}.`,
    noClaudeProfile: "The terminal didn't say which Claude profile it uses.",
    claudeProfileOutside: "Claude profile outside ~/.head-terminal/claude-profiles.",
    folderNotFound: (cwd) => `Terminal folder not found: ${cwd}`,
    alreadyRunning: "That analysis is already running.",
    startFailed: (agent, detail) => `Couldn't start ${agent}: ${detail}`,
    timedOut: (agent, minutes) => `${agent} ran past ${minutes} min and was stopped.`,
    replyTooLarge: (agent) => `${agent}'s reply got too large.`,
    cancelled: "Analysis cancelled.",
    agentReportedError: "the agent reported an error",
    emptyReply: "empty reply",
    exitedWith: (code) => `exited with code ${code ?? "unknown"}`,
    resumeFailed: "the previous conversation couldn't be resumed; starting over",
    steps: {
      reading: (file) => `reading ${file}`,
      readingAFile: "reading a file",
      searchingFor: (pattern) => `searching the code for "${pattern}"`,
      searchingCode: "searching the code",
      listing: (pattern) => `listing ${pattern}`,
      listingFiles: "listing files",
      searchingWebFor: (query) => `searching the web: ${query}`,
      searchingWeb: "searching the web",
      opening: (url) => `opening ${url}`,
      openingAPage: "opening a page",
      using: (tool) => `using ${tool}`,
      running: (command) => `running ${command}`,
    },
  },
};

export const main = { "pt-BR": ptBR, en };
