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
  data: string;
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
}

/** Windows only. Absent elsewhere, where there is no boundary to describe. */
export interface WslInfo {
  enabled: boolean;
  distro: string | null;
  available: string[];
}

export interface PlatformInfo {
  platform: NodeJS.Platform;
  arch: string;
  /** POSIX home in WSL mode, so paths built from it work inside the distro. */
  homeDir: string;
  wsl?: WslInfo;
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
    watch(input: GitWatchInput): Promise<void>;
    unwatch(watchId: string): Promise<void>;
    onChanged(callback: (event: GitChangedEvent) => void): Unsubscribe;
  };
  system: {
    getDefaultCwd(): Promise<string>;
    pathExists(path: string): Promise<boolean>;
    selectDirectory(defaultPath?: string): Promise<string | null>;
    confirm(input: ConfirmInput): Promise<boolean>;
    checkAgentClis(): Promise<AgentCliStatus>;
    deleteClaudeProfile(path: string): Promise<void>;
    getPlatform(): Promise<PlatformInfo>;
    /** Windows only; false when the distro is unknown. */
    selectWslDistro(distro: string): Promise<boolean>;
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
