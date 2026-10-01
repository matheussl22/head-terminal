import type { LanguagePreference, Locale } from "../../src/i18n/locale";
import type {
  RemoteCommandReply,
  RemoteCommandRequest,
  RemoteScreen,
  RemoteSnapshot,
  RemoteStatus,
} from "../../src/types/remote";
import type {
  WorktreeEntry,
  WorktreeInfo,
  WorktreePlan,
  WorktreeStatus,
} from "../services/git-worktree-service";

export type { WorktreeEntry, WorktreeInfo, WorktreePlan, WorktreeStatus };

export type Unsubscribe = () => void;

/** Trimmed agent lifecycle event routed to one pane (see src/types/agent-hooks.ts). */
export interface AgentHookEventPayload {
  paneId: string;
  source: "claude";
  event: string;
  notificationType?: string;
  toolName?: string;
  agentType?: string;
  error?: string;
  sessionId?: string;
  receivedAt: number;
}

export interface ClaudeHookSettings {
  /** `--settings` file with the status hooks of one pane. */
  settingsPath: string;
}

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
  /** What Settings holds; "auto" follows the machine. */
  languagePreference: LanguagePreference;
  /** The language "auto" means on this machine. */
  systemLocale: Locale;
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

/** An agent CLI found running inside a pane — e.g. `claude` typed in a shell. */
export type RunningAgent = "claude";

export interface PtyAgentEvent {
  id: string;
  /** `null` once it is gone again. */
  agent: RunningAgent | null;
}

/** What runs under one pane, read when deciding whether it may sleep. */
export interface PaneProcessInspection {
  /** Its root process (the shell node-pty started) is still there. */
  alive: boolean;
  /** Resident memory of the root and everything below it. */
  memoryBytes: number;
  /** Names of every process below the root, console hosts aside. */
  children: string[];
  /** Shells started by a program rather than by a shell — an agent's
   * background command (a dev server Claude left running). */
  detachedShells: string[];
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

export interface UsageSample {
  usedBytes: number;
  totalBytes: number;
  percent: number;
}

export interface DiskUsage extends UsageSample {
  /** The volume sampled — `C:` on Windows, the mount path elsewhere. */
  label: string;
}

export interface ResourceUsage {
  /** Host CPU busy percentage over the window since the previous read. */
  cpuPercent: number;
  memory: UsageSample;
  /** null when the volume could not be read (network drive down, no access). */
  disk: DiskUsage | null;
}

/** Agents whose plan limits the sidebar can show. */
export type UsageProvider = "claude" | "codex" | "cursor";

/**
 * Whose usage to read. A Claude pane runs on one of the app's profiles;
 * `global` is the `~/.claude` of a `claude` typed in a Shell session.
 * Codex and Cursor have one login per machine.
 */
export type UsageTarget =
  | { provider: "claude"; profileId: string }
  | { provider: "codex" }
  | { provider: "cursor" };

/** One limit of a plan, as the agent's own usage screen shows it. */
export interface UsageWindow {
  /** `session`: the rolling five hours. `week`: seven days. `cycle`: a
   * billing period (Cursor's month). */
  kind: "session" | "week" | "cycle";
  /** What the window counts when it is not everything: a model ("Fable"),
   * a pool ("API"). */
  label?: string;
  /** Share already used, 0-100. */
  percent: number;
  /** When it starts over (epoch ms); null while no window is open — the
   * five-hour one only starts with the next message. */
  resetsAt: number | null;
  /** Length of the window, for the pace mark; null when unknown. */
  windowMs: number | null;
}

/**
 * Why the numbers are old or missing: the access token expired while the
 * agent was not running to renew it, was refused, the endpoint throttled
 * us, the network failed, or there is no login this app can read.
 */
export type UsageProblem = "expired" | "auth" | "rate-limited" | "network" | "no-token";

export interface AgentUsage {
  provider: UsageProvider;
  /** `signed-out`: no account on the profile. `unavailable`: never read.
   * `stale`: numbers from an earlier read that could not be renewed. */
  status: "ok" | "stale" | "signed-out" | "unavailable";
  problem?: UsageProblem;
  /** "Pro", "Max 5x", "Plus", "Enterprise"… */
  plan?: string;
  /** The limits that bind everything, in the order they are shown. */
  windows: UsageWindow[];
  /** Narrower ones (one model, one pool): details, unless close to full. */
  extra: UsageWindow[];
  /** When the numbers were read (epoch ms). */
  fetchedAt?: number;
}

/** Agent CLIs a voice brainstorm can hand code questions to. */
export type BrainstormAgent = "claude" | "codex" | "cursor";

/** One thing said before a pause, replayed into the session that resumes it. */
export interface LiveHistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export interface LiveSessionInput {
  /** SDP offer from the renderer's RTCPeerConnection. */
  sdp: string;
  /** The pane's folder, named in GPT-Live's instructions. */
  cwd: string;
  /** null when the pane runs nothing that can read code (a shell, a local model). */
  agent: BrainstormAgent | null;
  /** Current git branch of the folder, when the app knows it. */
  branch?: string | null;
  /** Conversation before a pause, oldest first, for the session that resumes it. */
  history?: LiveHistoryMessage[];
  /** What happened while the voice was paused, and how to pick the conversation back up. */
  resumeNote?: string | null;
  /**
   * The pane's own agent conversation, so the voice picks it up instead of
   * starting from zero. The main process reads the CLI's transcript itself.
   */
  paneConversation?: LivePaneConversation;
}

export interface LivePaneConversation {
  agent: "claude" | "codex";
  sessionId: string;
  /** Claude only: the pane's profile, whose `projects/` holds the transcript. */
  claudeConfigDir?: string;
}

export interface LiveSessionAnswer {
  sessionId: string | null;
  /** SDP answer for `setRemoteDescription`. */
  sdp: string;
  /** Something about the folder the user should see before speaking. */
  warning?: string | null;
  /** What the voice was told of the pane's conversation; null when none was found. */
  paneConversation?: { messages: number; title: string | null } | null;
}

export interface LiveDelegationInput {
  /** GPT-Live's delegation id; also the handle to cancel the run. */
  delegationId: string;
  agent: BrainstormAgent;
  cwd: string;
  /** Recent conversation, oldest first, each line labelled by speaker. */
  transcript: string;
  /** True when `transcript` holds only what was said since the previous
   * delegation, because the agent conversation being resumed already has the rest. */
  continuation?: boolean;
  /** Images the user attached in the panel, as host paths the agent can read. */
  attachments?: string[];
  /** `CLAUDE_CONFIG_DIR` of the pane's Claude account. */
  claudeConfigDir?: string;
  /** Agent conversation to continue: the pane's own (forked, so it stays
   * untouched) on the first delegation, the brainstorm's own afterwards. */
  resume?: { sessionId: string; fork: boolean };
}

export interface LiveDelegationResult {
  /** A few sentences for GPT-Live to speak. */
  summary: string;
  /** The full answer, shown in the panel. */
  details: string;
  /** Agent conversation the next delegation resumes. */
  agentSessionId: string | null;
  /** What the agent reported spending on this run, when it says. */
  costUsd?: number | null;
  /** Folder the user asked to switch to, verified to exist; the next delegation runs there. */
  folder?: string | null;
  /** Model the agent ran with, when the app knows it. */
  model?: string | null;
}

/** A running analysis reporting on itself, one streamed line at a time. */
export interface LiveDelegationProgress {
  delegationId: string;
  /** A step worth showing, such as "lendo voice-service.ts". */
  text?: string;
  /** The agent conversation this run writes to, as soon as the CLI says. */
  agentSessionId?: string;
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
  /** Last time the transcript was written — what a fresh spawn is matched on. */
  updatedAt: string;
  /** When the conversation started. Fixed for its whole life, so the list is
   * ordered by it and does not reshuffle when one is resumed. */
  createdAt: string;
  /** True when `title` came from the opening user message, not a timestamp. */
  fromTranscript: boolean;
}

/** What a clicked notification points at. */
export interface NotificationTarget {
  sessionId: string;
  paneId?: string;
}

export interface NotificationInput {
  title: string;
  body: string;
  sessionId?: string;
  /** The terminal the notification is about: a click brings that pane on
   * screen, not just its session. */
  paneId?: string;
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
    wslDistro?: string;
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
    /** The UI language main resolved from the machine: "pt-BR" or "en". */
    locale: string;
    getStartupContext(): Promise<StartupContext>;
    setTitle(title: string): Promise<void>;
    requestClose(): Promise<void>;
    respondToClose(allow: boolean): void;
    onCloseRequested(callback: () => void): Unsubscribe;
    /** Saves the pick and switches main to it; resolves to the language to
     * switch the renderer to ("auto" resolved against the machine). */
    setLanguage(preference: LanguagePreference): Promise<Locale>;
    /** A folder sent from outside the app (Finder's Services menu, the Dock
     * icon) to start a session in. */
    onOpenFolder(callback: (folder: string) => void): Unsubscribe;
    /** The folder that arrived before the renderer was listening, if any.
     * Subscribe to `onOpenFolder` first: from this call on, main sends the
     * next ones there. */
    takePendingFolder(): Promise<string | null>;
  };
  terminal: {
    spawn(input: SpawnPtyInput): Promise<PtyHandle>;
    write(input: WritePtyInput): void;
    resize(input: ResizePtyInput): void;
    kill(id: string): Promise<void>;
    onData(callback: (event: PtyDataEvent) => void): Unsubscribe;
    onExit(callback: (event: PtyExitEvent) => void): Unsubscribe;
    onAgent(callback: (event: PtyAgentEvent) => void): Unsubscribe;
    /** What runs under each live pane among `ids`; panes without a pty are
     * left out. Reads the process table, about a second on Windows. */
    inspect(ids: string[]): Promise<Record<string, PaneProcessInspection>>;
  };
  git: {
    getContext(cwd: string): Promise<GitContextPayload>;
    getDiff(cwd: string): Promise<string>;
    /** Cria a árvore isolada `<repo>-agent-N` e devolve onde ela ficou. */
    createWorktree(
      cwd: string,
      options?: { copyIgnored?: boolean },
    ): Promise<WorktreeInfo>;
    /** Diz se uma sessão neste diretório deveria abrir em worktree próprio,
     * dado o que as outras sessões/terminais já estão ocupando. */
    planWorktree(input: {
      cwd: string;
      occupiedCwds?: readonly string[];
    }): Promise<WorktreePlan>;
    listWorktrees(cwd: string): Promise<WorktreeEntry[]>;
    worktreeStatus(path: string): Promise<WorktreeStatus>;
    removeWorktree(input: {
      path: string;
      /** Só apaga a branch se o worktree ainda estiver nela. */
      branch?: string;
      force?: boolean;
      deleteBranch?: boolean;
    }): Promise<void>;
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
    /** WSL distributions on this machine, the default first; empty off Windows
     * or without WSL. Docker Desktop's own distributions are left out. */
    listWslDistros(): Promise<string[]>;
    deleteClaudeProfile(path: string): Promise<void>;
    getPlatform(): Promise<PlatformInfo>;
    /** CPU/memory/disk of the whole machine, sampled since the previous call. */
    getResourceUsage(): Promise<ResourceUsage>;
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
  live: {
    createSession(input: LiveSessionInput): Promise<LiveSessionAnswer>;
    delegate(input: LiveDelegationInput): Promise<LiveDelegationResult>;
    cancelDelegation(delegationId: string): Promise<void>;
    /** Steps of a running delegation, as the agent's CLI streams them. */
    onDelegationProgress(callback: (event: LiveDelegationProgress) => void): Unsubscribe;
    /** F10, caught in the main process before Windows hands it to the menu bar:
     * starts the brainstorm, or pauses and resumes its voice. */
    onToggleRequested(callback: () => void): Unsubscribe;
    /** F11: ends the brainstorm, analyses included. */
    onEndRequested(callback: () => void): Unsubscribe;
  };
  mcp: {
    list(cwd: string, agent: SupportedAgent): Promise<McpServersPayload>;
  };
  usage: {
    /**
     * Plan limits of whoever `target` runs on, served from memory while
     * fresh; `refresh` reads them again unless they just were. Null when
     * that agent has no plan limits on this machine (Codex on an API key,
     * no Cursor login).
     */
    get(target: UsageTarget, refresh?: boolean): Promise<AgentUsage | null>;
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
    /** Saves a screenshot held in the clipboard as a PNG and returns its host path. */
    saveImage(): Promise<string | null>;
    /** Resolves an Electron drop/paste File to a host path in the preload. */
    pathForFile(file: unknown): string;
  };
  notifications: {
    show(input: NotificationInput): Promise<void>;
    onActivated(callback: (target: NotificationTarget) => void): Unsubscribe;
  };
  agentHooks: {
    /** Settings file for ONE pane: the pane id is written into it literally
     * (not read from an inherited env var), so a Claude background session
     * launched from that pane keeps reporting as that pane. Null when the
     * hook server is not running or the installed Claude Code cannot take
     * HTTP hooks — the pane then relies on its title/screen. */
    getClaudeSettings(paneId: string): Promise<ClaudeHookSettings | null>;
    onEvent(callback: (event: AgentHookEventPayload) => void): Unsubscribe;
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
  /** The phone remote (see src/types/remote.ts). */
  remote: {
    getStatus(): Promise<RemoteStatus>;
    setEnabled(enabled: boolean): Promise<RemoteStatus>;
    regeneratePin(): Promise<RemoteStatus>;
    revokeDevice(id: string): Promise<RemoteStatus>;
    revokeAllDevices(): Promise<RemoteStatus>;
    onStatus(callback: (status: RemoteStatus) => void): Unsubscribe;
    /** The sessions as the phone lists them; sent whenever they change. */
    publishState(snapshot: RemoteSnapshot): void;
    /** A watched pane's screen; sent whenever it changes. */
    publishScreen(screen: RemoteScreen): void;
    /** The panes some phone is looking at; their screens are wanted. */
    onWatch(callback: (paneIds: string[]) => void): Unsubscribe;
    getWatched(): Promise<string[]>;
    /** A phone's command, answered with `replyCommand`. */
    onCommand(callback: (request: RemoteCommandRequest) => void): Unsubscribe;
    replyCommand(reply: RemoteCommandReply): void;
  };
}
