import {
  app,
  clipboard,
  ipcMain,
  Notification,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";

import type {
  AgentCliInstallResult,
  AgentCliStatus,
  AllowedSecretKey,
  CheckpointInput,
  ConfirmInput,
  GitChangedEvent,
  GitContextPayload,
  GitWatchInput,
  McpServersPayload,
  MigratedPreferences,
  NotificationInput,
  PersistedWorkspace,
  PlatformInfo,
  PtyDataEvent,
  PtyExitEvent,
  PtyHandle,
  ResizePtyInput,
  ResumableAgent,
  ResumableSessionEntry,
  SecretBackendStatus,
  SpawnPtyInput,
  StartupContext,
  SupportedAgent,
  WritePtyInput,
} from "../types/api";
import { IPC_CHANNELS } from "./channels";
import { WINDOWS_SHELL_COMMAND } from "../../src/config/agents-shared";
import { unsupported } from "./errors";
import { asBoolean, asRecord, asString, assertTrustedSender } from "./validate";
import { isPersistedWorkspace } from "../services/workspace-service";
import { ClipboardPasteService } from "../services/clipboard-paste-service";

export interface IpcServices {
  terminal?: {
    spawn(ownerId: number, input: SpawnPtyInput): Promise<PtyHandle> | PtyHandle;
    write(ownerId: number, id: string, data: string): void;
    resize(ownerId: number, id: string, cols: number, rows: number): void;
    kill(ownerId: number, id: string): Promise<void> | void | boolean | Promise<boolean>;
    cleanup?(ownerId: number): Promise<number> | number | Promise<void> | void;
  };
  git?: {
    getContext(cwd: string): Promise<GitContextPayload>;
    getDiff(cwd: string): Promise<string>;
    createWorktree(cwd: string): Promise<string>;
    watch(
      input: GitWatchInput,
      emit: (event: GitChangedEvent) => void,
    ): Promise<void> | Promise<{ polling: boolean }>;
    unwatch(watchId: string): Promise<void>;
  };
  system?: {
    getDefaultCwd(): Promise<string> | string;
    pathExists(path: string): Promise<boolean>;
    selectDirectory(window: BrowserWindow, defaultPath?: string): Promise<string | null>;
    selectFile?(window: BrowserWindow, defaultPath?: string): Promise<string | null>;
    confirm(window: BrowserWindow, input: ConfirmInput): Promise<boolean>;
    checkAgentClis(): Promise<AgentCliStatus>;
    ensureAgentClis(): Promise<AgentCliInstallResult>;
    listOllamaModels?(): Promise<string[]>;
    deleteClaudeProfile(path: string): Promise<void>;
    getPlatform(): Promise<PlatformInfo> | PlatformInfo;
  };
  secrets?: {
    has(key: AllowedSecretKey): Promise<boolean>;
    set(key: AllowedSecretKey, value: string): Promise<void>;
    delete(key: AllowedSecretKey): Promise<void>;
    getBackendStatus(): Promise<SecretBackendStatus>;
  };
  voice?: {
    start(ownerId: number): Promise<void>;
    stopAndTranscribe(): Promise<string>;
    cancel(): Promise<void>;
    transcribeAudio(bytes: Uint8Array, mimeType: string): Promise<string>;
    cleanup?(ownerId: number): Promise<void> | void;
  };
  mcp?: {
    list(cwd: string, agent: SupportedAgent): Promise<McpServersPayload>;
  };
  sessions?: {
    listResumable(
      cwd: string,
      agent: ResumableAgent,
      claudeConfigDir?: string,
    ): Promise<ResumableSessionEntry[]>;
  };
  diagnostics?: {
    appendEvent(line: string): Promise<void> | void;
    appendCheckpoint(input: CheckpointInput): Promise<void> | void;
    export(frontend: unknown): Promise<string>;
  };
  workspace?: {
    load(): Promise<PersistedWorkspace | null>;
    save(workspace: PersistedWorkspace): Promise<void>;
  };
  migration?: {
    loadPreferences(): Promise<MigratedPreferences>;
  };
  clipboardPaste?: {
    readForTerminal(): Promise<string | null>;
    importPaths(paths: unknown): Promise<string | null>;
  };
}

export interface RegisterIpcOptions {
  window: BrowserWindow;
  services?: IpcServices;
  isQuitting?: () => boolean;
  runId?: string;
}

let removeCurrentHandlers: (() => void) | null = null;

export function registerIpc({
  window,
  services = {},
  isQuitting = () => false,
  runId = "main-process",
}: RegisterIpcOptions): () => void {
  removeCurrentHandlers?.();

  const registeredHandles: string[] = [];
  const registeredListeners: Array<[string, (...args: any[]) => void]> = [];
  const trusted = window.webContents;
  const ownerId = trusted.id;
  let closeApproved = false;
  const ownedGitWatches = new Set<string>();

  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ) => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event, trusted);
      return listener(event, ...args);
    });
    registeredHandles.push(channel);
  };

  const on = (
    channel: string,
    listener: (event: IpcMainEvent, ...args: unknown[]) => void,
  ) => {
    const guarded = (event: IpcMainEvent, ...args: unknown[]) => {
      try {
        assertTrustedSender(event, trusted);
        listener(event, ...args);
      } catch {
        // One-way IPC has no rejection channel. Drop malformed/untrusted
        // messages instead of surfacing an uncaught EventEmitter exception.
      }
    };
    ipcMain.on(channel, guarded);
    registeredListeners.push([channel, guarded]);
  };

  const send = (channel: string, payload?: unknown) => {
    if (!trusted.isDestroyed()) trusted.send(channel, payload);
  };

  handle(IPC_CHANNELS.app.getStartupContext, (): StartupContext => ({
    isPackaged: app.isPackaged,
    runId,
    channel: app.isPackaged ? "prod" : "dev",
    smokeTest: process.env.HEAD_TERMINAL_SMOKE === "1",
    platform: process.platform,
    version: app.getVersion(),
    userDataPath: app.getPath("userData"),
  }));
  handle(IPC_CHANNELS.app.setTitle, (_event, value) => {
    window.setTitle(asString(value, "title", { maxLength: 256 }));
  });
  handle(IPC_CHANNELS.app.requestClose, () => window.close());
  on(IPC_CHANNELS.app.respondToClose, (_event, value) => {
    if (!asBoolean(value, "allow")) return;
    closeApproved = true;
    window.close();
  });

  handle(IPC_CHANNELS.terminal.spawn, (_event, value) => {
    const input = validateSpawnInput(value);
    return services.terminal?.spawn(ownerId, input) ?? unsupported("terminal.spawn");
  });
  on(IPC_CHANNELS.terminal.write, (_event, value) => {
    const input = validateWriteInput(value);
    if (!services.terminal) unsupported("terminal.write");
    services.terminal.write(ownerId, input.id, input.data);
  });
  on(IPC_CHANNELS.terminal.resize, (_event, value) => {
    const input = validateResizeInput(value);
    if (!services.terminal) unsupported("terminal.resize");
    services.terminal.resize(ownerId, input.id, input.cols, input.rows);
  });
  handle(IPC_CHANNELS.terminal.kill, (_event, value) =>
    services.terminal?.kill(ownerId, asString(value, "id", { maxLength: 256 })) ??
      unsupported("terminal.kill"),
  );

  handle(IPC_CHANNELS.git.getContext, (_event, value) =>
    services.git?.getContext(asString(value, "cwd", { maxLength: 16_384 })) ??
      unsupported("git.getContext"),
  );
  handle(IPC_CHANNELS.git.getDiff, (_event, value) =>
    services.git?.getDiff(asString(value, "cwd", { maxLength: 16_384 })) ??
      unsupported("git.getDiff"),
  );
  handle(IPC_CHANNELS.git.createWorktree, (_event, value) =>
    services.git?.createWorktree(asString(value, "cwd", { maxLength: 16_384 })) ??
      unsupported("git.createWorktree"),
  );
  handle(IPC_CHANNELS.git.watch, (_event, value) => {
    const input = validateGitWatchInput(value);
    const result = (
      services.git?.watch(input, (payload) => send(IPC_CHANNELS.git.changed, payload)) ??
      unsupported("git.watch")
    );
    return Promise.resolve(result).then((value) => {
      ownedGitWatches.add(input.watchId);
      return value;
    });
  });
  handle(IPC_CHANNELS.git.unwatch, (_event, value) => {
    const watchId = asString(value, "watchId", { maxLength: 256 });
    const result = services.git?.unwatch(watchId) ?? unsupported("git.unwatch");
    return Promise.resolve(result).then(() => {
      ownedGitWatches.delete(watchId);
    });
  });

  handle(IPC_CHANNELS.system.getDefaultCwd, () =>
    services.system?.getDefaultCwd() ?? unsupported("system.getDefaultCwd"),
  );
  handle(IPC_CHANNELS.system.pathExists, (_event, value) =>
    services.system?.pathExists(asString(value, "path", { maxLength: 16_384 })) ??
      unsupported("system.pathExists"),
  );
  handle(IPC_CHANNELS.system.selectDirectory, (_event, value) =>
    services.system?.selectDirectory(
      window,
      value === undefined ? undefined : asString(value, "defaultPath", { maxLength: 16_384 }),
    ) ?? unsupported("system.selectDirectory"),
  );
  handle(IPC_CHANNELS.system.selectFile, (_event, value) =>
    services.system?.selectFile?.(
      window,
      value === undefined ? undefined : asString(value, "defaultPath", { maxLength: 16_384 }),
    ) ?? unsupported("system.selectFile"),
  );
  handle(IPC_CHANNELS.system.confirm, (_event, value) =>
    services.system?.confirm(window, validateConfirmInput(value)) ??
      unsupported("system.confirm"),
  );
  handle(IPC_CHANNELS.system.checkAgentClis, () =>
    services.system?.checkAgentClis() ?? unsupported("system.checkAgentClis"),
  );
  handle(IPC_CHANNELS.system.ensureAgentClis, () =>
    services.system?.ensureAgentClis() ?? unsupported("system.ensureAgentClis"),
  );
  handle(IPC_CHANNELS.system.listOllamaModels, () =>
    services.system?.listOllamaModels?.() ??
      unsupported("system.listOllamaModels"),
  );
  handle(IPC_CHANNELS.system.deleteClaudeProfile, (_event, value) =>
    services.system?.deleteClaudeProfile(
      asString(value, "path", { maxLength: 16_384 }),
    ) ?? unsupported("system.deleteClaudeProfile"),
  );
  handle(IPC_CHANNELS.system.getPlatform, () =>
    services.system?.getPlatform() ?? unsupported("system.getPlatform"),
  );

  handle(IPC_CHANNELS.secrets.has, (_event, value) =>
    services.secrets?.has(validateSecretKey(value)) ?? unsupported("secrets.has"),
  );
  handle(IPC_CHANNELS.secrets.set, (_event, key, value) =>
    services.secrets?.set(
      validateSecretKey(key),
      asString(value, "value", { maxLength: 64_000 }),
    ) ?? unsupported("secrets.set"),
  );
  handle(IPC_CHANNELS.secrets.delete, (_event, value) =>
    services.secrets?.delete(validateSecretKey(value)) ?? unsupported("secrets.delete"),
  );
  handle(IPC_CHANNELS.secrets.getBackendStatus, () =>
    services.secrets?.getBackendStatus() ?? unsupported("secrets.getBackendStatus"),
  );

  handle(IPC_CHANNELS.voice.start, () =>
    services.voice?.start(ownerId) ?? unsupported("voice.start"),
  );
  handle(IPC_CHANNELS.voice.stopAndTranscribe, () =>
    services.voice?.stopAndTranscribe() ?? unsupported("voice.stopAndTranscribe"),
  );
  handle(IPC_CHANNELS.voice.cancel, () =>
    services.voice?.cancel() ?? unsupported("voice.cancel"),
  );
  handle(IPC_CHANNELS.voice.transcribeAudio, (_event, bytes, mimeType) => {
    // Structured clone hands this over as a Uint8Array; anything else is a
    // renderer that does not speak this contract.
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("Voice audio must be a Uint8Array");
    }
    if (typeof mimeType !== "string") {
      throw new TypeError("Voice mime type must be a string");
    }
    return (
      services.voice?.transcribeAudio(bytes, mimeType)
      ?? unsupported("voice.transcribeAudio")
    );
  });
  handle(IPC_CHANNELS.mcp.list, (_event, cwd, agent) =>
    services.mcp?.list(
      asString(cwd, "cwd", { maxLength: 16_384 }),
      validateAgent(agent),
    ) ?? unsupported("mcp.list"),
  );
  handle(IPC_CHANNELS.sessions.listResumable, (_event, cwd, agent, claudeConfigDir) =>
    services.sessions?.listResumable(
      asString(cwd, "cwd", { maxLength: 16_384 }),
      validateResumableAgent(agent),
      asOptionalString(claudeConfigDir, "claudeConfigDir", { maxLength: 4_096 }),
    ) ?? unsupported("sessions.listResumable"),
  );

  handle(IPC_CHANNELS.clipboard.readText, () => clipboard.readText());
  handle(IPC_CHANNELS.clipboard.writeText, (_event, value) => {
    clipboard.writeText(asString(value, "text", { allowEmpty: true }));
  });
  const pasteService = services.clipboardPaste ?? new ClipboardPasteService({
    clipboard,
  });
  handle(IPC_CHANNELS.clipboard.readForTerminal, () => pasteService.readForTerminal());
  handle(IPC_CHANNELS.clipboard.importPaths, (_event, paths) =>
    pasteService.importPaths(paths),
  );
  handle(IPC_CHANNELS.notifications.show, (_event, value) => {
    const input = validateNotificationInput(value);
    if (!Notification.isSupported()) return;
    const notification = new Notification(input);
    notification.on("click", () => {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      if (input.sessionId) {
        send(IPC_CHANNELS.notifications.activated, input.sessionId);
      }
    });
    notification.show();
  });

  on(IPC_CHANNELS.diagnostics.appendEvent, (_event, value) => {
    void services.diagnostics?.appendEvent(
      asString(value, "line", { allowEmpty: true, maxLength: 1_000_000 }),
    );
  });
  on(IPC_CHANNELS.diagnostics.appendCheckpoint, (_event, value) => {
    void services.diagnostics?.appendCheckpoint(validateCheckpointInput(value));
  });
  handle(IPC_CHANNELS.diagnostics.export, (_event, value) =>
    services.diagnostics?.export(value) ?? unsupported("diagnostics.export"),
  );
  handle(IPC_CHANNELS.workspace.load, () =>
    services.workspace?.load() ?? unsupported("workspace.load"),
  );
  handle(IPC_CHANNELS.workspace.save, (_event, value) =>
    services.workspace?.save(validateWorkspace(value)) ??
      unsupported("workspace.save"),
  );
  handle(IPC_CHANNELS.migration.loadPreferences, () =>
    services.migration?.loadPreferences() ??
      unsupported("migration.loadPreferences"),
  );

  const onWindowClose = (event: Electron.Event) => {
    if (closeApproved || isQuitting()) return;
    event.preventDefault();
    send(IPC_CHANNELS.app.closeRequested);
  };
  let cleanupStarted = false;
  const cleanupOwner = () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    void services.terminal?.cleanup?.(ownerId);
    void services.voice?.cleanup?.(ownerId);
    for (const watchId of ownedGitWatches) {
      void services.git?.unwatch(watchId);
    }
    ownedGitWatches.clear();
  };
  const resetOwnerCleanup = () => {
    cleanupStarted = false;
  };
  const onRendererReload = () => {
    cleanupOwner();
    resetOwnerCleanup();
  };
  window.on("close", onWindowClose);
  window.webContents.on("destroyed", cleanupOwner);
  window.webContents.on("render-process-gone", cleanupOwner);
  window.webContents.on("did-start-loading", onRendererReload);

  const remove = () => {
    registeredHandles.forEach((channel) => ipcMain.removeHandler(channel));
    registeredListeners.forEach(([channel, listener]) =>
      ipcMain.removeListener(channel, listener),
    );
    window.removeListener("close", onWindowClose);
    if (!window.webContents.isDestroyed()) {
      window.webContents.removeListener("destroyed", cleanupOwner);
      window.webContents.removeListener("render-process-gone", cleanupOwner);
      window.webContents.removeListener("did-start-loading", onRendererReload);
    }
  };
  removeCurrentHandlers = remove;
  return remove;
}

export function emitPtyData(window: BrowserWindow, payload: PtyDataEvent): void {
  if (!window.webContents.isDestroyed()) {
    window.webContents.send(IPC_CHANNELS.terminal.data, payload);
  }
}

export function emitPtyExit(window: BrowserWindow, payload: PtyExitEvent): void {
  if (!window.webContents.isDestroyed()) {
    window.webContents.send(IPC_CHANNELS.terminal.exit, payload);
  }
}

const ZSH_COMMANDS = new Set(["/bin/zsh", "/usr/bin/zsh"]);
/** The only PowerShell switches a pane may start with; the script itself
 * travels base64-encoded after `-EncodedCommand`. */
const POWERSHELL_SWITCHES = new Set([
  "-NoLogo",
  "-NoExit",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

/**
 * A pane launches one of two shells, each with a fixed argv shape: a login
 * zsh with at most `-l -c <script>`, or PowerShell with a handful of switches
 * and an encoded script. Anything else is not something the renderer builds.
 */
function validateShellArgs(command: string, args: unknown): string[] {
  if (
    !Array.isArray(args)
    || !args.every((arg): arg is string => typeof arg === "string" && arg.length <= 32_768)
  ) {
    throw new TypeError("args must be an array of strings");
  }
  if (ZSH_COMMANDS.has(command)) {
    if (args.length > 3) {
      throw new TypeError("args must be an array of strings");
    }
    return args;
  }
  // PowerShell: every switch from the allowlist, and an encoded script only
  // right after -EncodedCommand.
  if (args.length > 6) {
    throw new TypeError("args must be an array of strings");
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (POWERSHELL_SWITCHES.has(arg)) {
      continue;
    }
    const previous = index > 0 ? args[index - 1] : undefined;
    if (previous === "-EncodedCommand" && BASE64.test(arg)) {
      continue;
    }
    throw new TypeError("args must be an array of strings");
  }
  return args;
}

function validateSpawnInput(value: unknown): SpawnPtyInput {
  const input = asRecord(value, "input");
  const cols = positiveInteger(input.cols, "cols", 1_000);
  const rows = positiveInteger(input.rows, "rows", 1_000);
  const command = asString(input.command, "command", { maxLength: 16_384 });
  if (!ZSH_COMMANDS.has(command) && command !== WINDOWS_SHELL_COMMAND) {
    throw new TypeError("command must be an approved shell");
  }
  const args = validateShellArgs(command, input.args);
  const env = input.env === undefined ? undefined : asStringRecord(input.env, "env");
  const allowedEnv = new Set([
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "CLAUDE_CONFIG_DIR",
  ]);
  if (env && Object.keys(env).some((key) => !allowedEnv.has(key))) {
    throw new TypeError("env contains a variable that is not allowed");
  }
  return {
    id: asString(input.id, "id", { maxLength: 256 }),
    command,
    args,
    cwd: asString(input.cwd, "cwd", { maxLength: 16_384 }),
    cols,
    rows,
    env,
  };
}

function validateWriteInput(value: unknown): WritePtyInput {
  const input = asRecord(value, "input");
  return {
    id: asString(input.id, "id", { maxLength: 256 }),
    data: asString(input.data, "data", { allowEmpty: true }),
  };
}

function validateResizeInput(value: unknown): ResizePtyInput {
  const input = asRecord(value, "input");
  return {
    id: asString(input.id, "id", { maxLength: 256 }),
    cols: positiveInteger(input.cols, "cols", 1_000),
    rows: positiveInteger(input.rows, "rows", 1_000),
  };
}

function validateGitWatchInput(value: unknown): GitWatchInput {
  const input = asRecord(value, "input");
  return {
    watchId: asString(input.watchId, "watchId", { maxLength: 256 }),
    cwd: asString(input.cwd, "cwd", { maxLength: 16_384 }),
  };
}

function validateConfirmInput(value: unknown): ConfirmInput {
  const input = asRecord(value, "input");
  const optional = (key: string, maxLength = 4_096) =>
    input[key] === undefined
      ? undefined
      : asString(input[key], key, { maxLength });
  return {
    title: optional("title", 256),
    message: asString(input.message, "message", { maxLength: 4_096 }),
    detail: optional("detail"),
    confirmLabel: optional("confirmLabel", 128),
    cancelLabel: optional("cancelLabel", 128),
  };
}

function validateSecretKey(value: unknown): AllowedSecretKey {
  if (value !== "openai-api-key") throw new TypeError("secret key is not allowed");
  return value;
}

function validateAgent(value: unknown): SupportedAgent {
  if (value !== "claude" && value !== "cursor") {
    throw new TypeError("agent must be claude or cursor");
  }
  return value;
}

function validateResumableAgent(value: unknown): ResumableAgent {
  if (value !== "claude" && value !== "codex" && value !== "cursor") {
    throw new TypeError("agent must be claude, codex or cursor");
  }
  return value;
}

function validateNotificationInput(value: unknown): NotificationInput {
  const input = asRecord(value, "input");
  return {
    title: asString(input.title, "title", { maxLength: 256 }),
    body: asString(input.body, "body", { maxLength: 4_096 }),
    sessionId:
      input.sessionId === undefined
        ? undefined
        : asString(input.sessionId, "sessionId", { maxLength: 256 }),
    silent: input.silent === undefined ? undefined : asBoolean(input.silent, "silent"),
  };
}

function validateCheckpointInput(value: unknown): CheckpointInput {
  const input = asRecord(value, "input");
  if (typeof input.elapsedMs !== "number" || !Number.isFinite(input.elapsedMs)) {
    throw new TypeError("elapsedMs must be a finite number");
  }
  return {
    checkpoint: asString(input.checkpoint, "checkpoint", { maxLength: 256 }),
    elapsedMs: input.elapsedMs,
    metadata:
      input.metadata === undefined ? undefined : asRecord(input.metadata, "metadata"),
  };
}

function positiveInteger(value: unknown, field: string, max: number): number {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > max) {
    throw new TypeError(`${field} must be an integer between 1 and ${max}`);
  }
  return value as number;
}

function asOptionalString(
  value: unknown,
  field: string,
  options: { maxLength?: number } = {},
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return asString(value, field, { maxLength: options.maxLength });
}

function asStringRecord(value: unknown, field: string): Record<string, string> {
  const record = asRecord(value, field);
  if (!Object.values(record).every((item) => typeof item === "string")) {
    throw new TypeError(`${field} values must be strings`);
  }
  return record as Record<string, string>;
}

function validateWorkspace(value: unknown): PersistedWorkspace {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) {
    throw new TypeError("workspace version must be 1");
  }
  if (!isPersistedWorkspace(value)) {
    throw new TypeError("workspace schema is invalid or exceeds safety limits");
  }
  return value;
}
