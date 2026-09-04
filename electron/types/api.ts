export type Unsubscribe = () => void;

export type AllowedSecretKey = "openai-api-key";
export type SupportedAgent = "claude" | "cursor";
export type ResumableAgent = "claude" | "codex" | "cursor";

export interface StartupContext {
  isPackaged: boolean;
  runId: string;
  channel: "dev" | "prod";
  smokeTest: boolean;
  platform: NodeJS.Platform;
  version: string;
  userDataPath: string;
}

export interface SpawnPtyInput {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export interface PtyHandle {
  id: string;
  pid: number;
}

export interface WritePtyInput {
  id: string;
  data: string;
}

export interface ResizePtyInput {
  id: string;
  cols: number;
  rows: number;
}

export interface PtyDataEvent {
  id: string;
  data: string | Uint8Array;
}

export interface PtyExitEvent {
  id: string;
  exitCode: number;
  signal?: number;
}

export interface GitContextPayload {
  repoRoot: string | null;
  branch: string | null;
  headShort: string | null;
  headRef: string;
  isDirty: boolean;
}

export interface GitWatchInput {
  watchId: string;
  cwd: string;
}

export interface GitChangedEvent {
  watchId: string;
  context: GitContextPayload;
}

export interface ConfirmInput {
  title?: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface AgentCliStatus {
  antigravity: boolean;
  claude: boolean;
  cursor: boolean;
  codex: boolean;
  ollama: boolean;
  ornith: boolean;
}

export type InstallableAgentId = "cursor" | "claude" | "codex";

export interface AgentCliInstallResult {
  status: AgentCliStatus;
  installed: InstallableAgentId[];
  failed: Array<{ id: InstallableAgentId; error: string }>;
}

export interface PlatformInfo {
  platform: NodeJS.Platform;
  arch: string;
  /** The user's home as the host spells it (`C:\Users\x` on Windows). */
  homeDir: string;
  /** Windows only. Feeds xterm.js's `windowsPty` option, which compensates
   * for how ConPTY reflows the screen on redraw/resize. */
  windowsBuild?: number;
}

export interface SecretBackendStatus {
  available: boolean;
  encrypted: boolean;
  backend: "safeStorage" | "unavailable";
  reason?: string;
}

export interface McpServerStatus {
  name: string;
  target: string;
  status: string;
}

export interface McpServersPayload {
  servers: McpServerStatus[];
  error: string | null;
}

/** One CLI-level agent conversation that can be resumed by id (best-effort
 * metadata read from that agent's on-disk transcript — never authoritative). */
export interface ResumableSessionEntry {
  id: string;
  title: string;
  updatedAt: string;
  /** True when `title` came from the opening user message, not a timestamp. */
  fromTranscript: boolean;
}

export interface NotificationInput {
  title: string;
  body: string;
  sessionId?: string;
  silent?: boolean;
}

export interface CheckpointInput {
  checkpoint: string;
  elapsedMs: number;
  metadata?: Record<string, unknown>;
}

export interface PersistedWorkspace {
  version: number;
  activeSessionId: string | null;
  activePaneId: string | null;
  sessions: Array<{
    id: string;
    title: string;
    cwd: string;
    agentProfileId: string;
    claudeAccountId?: string;
    ollamaModel?: string;
    ollamaThinkOff?: boolean;
    ggufPath?: string;
    layout: unknown;
    pinned?: boolean;
  }>;
  /** paneId -> last known CLI session id, so a restart can `--resume` each
   * pane's own conversation instead of a blanket `--continue` that collides
   * whenever panes share a cwd (see session-manager.ts hydrateWorkspace). */
  paneResumeSessionIds?: Record<string, string>;
  /** CLI session id -> name the user gave that conversation, so a renamed
   * conversation stays renamed across restarts. */
  conversationLabels?: Record<string, string>;
}

export type MigratedPreferences = Record<string, string>;

export interface HeadTerminalApi {
  app: {
    getStartupContext(): Promise<StartupContext>;
    setTitle(title: string): Promise<void>;
    requestClose(): Promise<void>;
    respondToClose(allow: boolean): void;
    onCloseRequested(callback: () => void): Unsubscribe;
  };
  terminal: {
    spawn(input: SpawnPtyInput): Promise<PtyHandle>;
    write(input: WritePtyInput): void;
    resize(input: ResizePtyInput): void;
    kill(id: string): Promise<void>;
    onData(callback: (event: PtyDataEvent) => void): Unsubscribe;
    onExit(callback: (event: PtyExitEvent) => void): Unsubscribe;
  };
  git: {
    getContext(cwd: string): Promise<GitContextPayload>;
    getDiff(cwd: string): Promise<string>;
    createWorktree(cwd: string): Promise<string>;
    watch(input: GitWatchInput): Promise<{ polling?: boolean } | void>;
    unwatch(watchId: string): Promise<void>;
    onChanged(callback: (event: GitChangedEvent) => void): Unsubscribe;
  };
  system: {
    getDefaultCwd(): Promise<string>;
    pathExists(path: string): Promise<boolean>;
    selectDirectory(defaultPath?: string): Promise<string | null>;
    /** Open a file picker. Used for GGUF weights that live only on this machine. */
    selectFile(defaultPath?: string): Promise<string | null>;
    confirm(input: ConfirmInput): Promise<boolean>;
    checkAgentClis(): Promise<AgentCliStatus>;
    ensureAgentClis(): Promise<AgentCliInstallResult>;
    /** Models already pulled locally; empty when ollama or its daemon is off. */
    listOllamaModels(): Promise<string[]>;
    deleteClaudeProfile(path: string): Promise<void>;
    getPlatform(): Promise<PlatformInfo>;
  };
  secrets: {
    has(key: AllowedSecretKey): Promise<boolean>;
    set(key: AllowedSecretKey, value: string): Promise<void>;
    delete(key: AllowedSecretKey): Promise<void>;
    getBackendStatus(): Promise<SecretBackendStatus>;
  };
  voice: {
    start(): Promise<void>;
    stopAndTranscribe(): Promise<string>;
    cancel(): Promise<void>;
    /** Transcribes audio the renderer captured through Chromium's mic stack. */
    transcribeAudio(bytes: Uint8Array, mimeType: string): Promise<string>;
  };
  mcp: {
    list(cwd: string, agent: SupportedAgent): Promise<McpServersPayload>;
  };
  sessions: {
    listResumable(
      cwd: string,
      agent: ResumableAgent,
      claudeConfigDir?: string,
    ): Promise<ResumableSessionEntry[]>;
  };
  clipboard: {
    readText(): Promise<string>;
    writeText(text: string): Promise<void>;
    /**
     * Text, copied-file paths, or a screenshot saved to disk — already in the
     * form the agent PTY can read (POSIX under WSL).
     */
    readForTerminal(): Promise<string | null>;
    importPaths(paths: string[]): Promise<string | null>;
    /** Resolves an Electron drop/paste File to a host path in the preload. */
    pathForFile(file: unknown): string;
  };
  notifications: {
    show(input: NotificationInput): Promise<void>;
    onActivated(callback: (sessionId: string) => void): Unsubscribe;
  };
  diagnostics: {
    appendEvent(line: string): void;
    appendCheckpoint(input: CheckpointInput): void;
    export(frontend: unknown): Promise<string>;
  };
  workspace: {
    load(): Promise<PersistedWorkspace | null>;
    save(workspace: PersistedWorkspace): Promise<void>;
  };
  migration: {
    loadPreferences(): Promise<MigratedPreferences>;
  };
}
