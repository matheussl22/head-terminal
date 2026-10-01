export const IPC_CHANNELS = {
  app: {
    getStartupContext: "app:get-startup-context",
    setTitle: "app:set-title",
    requestClose: "app:request-close",
    respondToClose: "app:respond-to-close",
    closeRequested: "app:close-requested",
    setLanguage: "app:set-language",
    openFolder: "app:open-folder",
    takePendingFolder: "app:take-pending-folder",
  },
  terminal: {
    spawn: "terminal:spawn",
    write: "terminal:write",
    resize: "terminal:resize",
    kill: "terminal:kill",
    data: "terminal:data",
    exit: "terminal:exit",
    agent: "terminal:agent",
    inspect: "terminal:inspect",
  },
  git: {
    getContext: "git:get-context",
    getDiff: "git:get-diff",
    createWorktree: "git:create-worktree",
    planWorktree: "git:plan-worktree",
    listWorktrees: "git:list-worktrees",
    worktreeStatus: "git:worktree-status",
    removeWorktree: "git:remove-worktree",
    watch: "git:watch",
    unwatch: "git:unwatch",
    changed: "git:changed",
  },
  system: {
    getDefaultCwd: "system:get-default-cwd",
    pathExists: "system:path-exists",
    selectDirectory: "system:select-directory",
    selectFile: "system:select-file",
    confirm: "system:confirm",
    checkAgentClis: "system:check-agent-clis",
    ensureAgentClis: "system:ensure-agent-clis",
    listOllamaModels: "system:list-ollama-models",
    listWslDistros: "system:list-wsl-distros",
    deleteClaudeProfile: "system:delete-claude-profile",
    getPlatform: "system:get-platform",
    getResourceUsage: "system:get-resource-usage",
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
  live: {
    createSession: "live:create-session",
    delegate: "live:delegate",
    cancelDelegation: "live:cancel-delegation",
    delegationProgress: "live:delegation-progress",
    toggleRequested: "live:toggle-requested",
    endRequested: "live:end-requested",
  },
  mcp: { list: "mcp:list" },
  usage: { get: "usage:get" },
  sessions: { listResumable: "sessions:list-resumable" },
  clipboard: {
    readText: "clipboard:read-text",
    writeText: "clipboard:write-text",
    readForTerminal: "clipboard:read-for-terminal",
    importPaths: "clipboard:import-paths",
    saveImage: "clipboard:save-image",
  },
  notifications: {
    show: "notifications:show",
    activated: "notifications:activated",
  },
  agentHooks: {
    getClaudeSettings: "agent-hooks:get-claude-settings",
    /** Main → renderer: a lifecycle event an agent reported for one pane. */
    event: "agent-hooks:event",
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
  remote: {
    getStatus: "remote:get-status",
    setEnabled: "remote:set-enabled",
    regeneratePin: "remote:regenerate-pin",
    revokeDevice: "remote:revoke-device",
    revokeAllDevices: "remote:revoke-all-devices",
    /** Main → renderer: the remote's status changed (PIN, devices, up/down). */
    status: "remote:status",
    publishState: "remote:publish-state",
    publishScreen: "remote:publish-screen",
    /** Main → renderer: panes whose screens some phone is looking at. */
    watch: "remote:watch",
    /** The panes phones look at now, for a renderer that just (re)loaded. */
    getWatched: "remote:get-watched",
    /** Main → renderer: a phone's command. */
    command: "remote:command",
    commandReply: "remote:command-reply",
  },
} as const;

type LeafValues<T> = T extends string
  ? T
  : { [K in keyof T]: LeafValues<T[K]> }[keyof T];

export type IpcChannel = LeafValues<typeof IPC_CHANNELS>;

/**
 * Not a channel: the command-line switch main appends for the preload
 * (`webPreferences.additionalArguments`) carrying the UI language, which the
 * renderer needs before its first module runs — too early for any IPC.
 */
export const LOCALE_ARGUMENT = "--head-terminal-locale=";
