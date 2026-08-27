export const IPC_CHANNELS = {
  app: {
    getStartupContext: "app:get-startup-context",
    setTitle: "app:set-title",
    requestClose: "app:request-close",
    respondToClose: "app:respond-to-close",
    closeRequested: "app:close-requested",
  },
  terminal: {
    spawn: "terminal:spawn",
    write: "terminal:write",
    resize: "terminal:resize",
    kill: "terminal:kill",
    data: "terminal:data",
    exit: "terminal:exit",
  },
  git: {
    getContext: "git:get-context",
    getDiff: "git:get-diff",
    createWorktree: "git:create-worktree",
    watch: "git:watch",
    unwatch: "git:unwatch",
    changed: "git:changed",
  },
  system: {
    getDefaultCwd: "system:get-default-cwd",
    pathExists: "system:path-exists",
    selectDirectory: "system:select-directory",
    confirm: "system:confirm",
    checkAgentClis: "system:check-agent-clis",
    ensureAgentClis: "system:ensure-agent-clis",
    deleteClaudeProfile: "system:delete-claude-profile",
    getPlatform: "system:get-platform",
    selectWslDistro: "system:select-wsl-distro",
  },
  secrets: {
    has: "secrets:has",
    set: "secrets:set",
    delete: "secrets:delete",
    getBackendStatus: "secrets:get-backend-status",
  },
  voice: {
    start: "voice:start",
    stopAndTranscribe: "voice:stop-and-transcribe",
    cancel: "voice:cancel",
    /** Audio the renderer recorded itself, where the main process cannot. */
    transcribeAudio: "voice:transcribe-audio",
  },
  mcp: { list: "mcp:list" },
  sessions: { listResumable: "sessions:list-resumable" },
  clipboard: {
    readText: "clipboard:read-text",
    writeText: "clipboard:write-text",
    readForTerminal: "clipboard:read-for-terminal",
    importPaths: "clipboard:import-paths",
  },
  notifications: {
    show: "notifications:show",
    activated: "notifications:activated",
  },
  diagnostics: {
    appendEvent: "diagnostics:append-event",
    appendCheckpoint: "diagnostics:append-checkpoint",
    export: "diagnostics:export",
  },
  workspace: {
    load: "workspace:load",
    save: "workspace:save",
  },
  migration: {
    loadPreferences: "migration:load-preferences",
  },
} as const;

type LeafValues<T> = T extends string
  ? T
  : { [K in keyof T]: LeafValues<T[K]> }[keyof T];

export type IpcChannel = LeafValues<typeof IPC_CHANNELS>;
