import { contextBridge, ipcRenderer, webUtils } from "electron";

import { IPC_CHANNELS } from "./ipc/channels";
import type {
  AgentHookEventPayload,
  GitChangedEvent,
  HeadTerminalApi,
  LiveDelegationProgress,
  PtyDataEvent,
  PtyExitEvent,
  Unsubscribe,
} from "./types/api";

type Delivery = (payload: unknown) => void;

interface ChannelFanout {
  listener: (event: Electron.IpcRendererEvent, payload: unknown) => void;
  deliveries: Set<Delivery>;
}

const fanouts = new Map<string, ChannelFanout>();

/**
 * One ipcRenderer listener per channel, handing each event to every
 * subscriber. Each pane subscribes to terminal:data and terminal:exit (a
 * Claude pane to the hook events too), so with one listener apiece a grid of
 * 11 panes tripped Node's MaxListenersExceededWarning — a leak warning for
 * what is only a busy session.
 */
function subscribe<T>(channel: string, callback: (event: T) => void): Unsubscribe {
  let fanout = fanouts.get(channel);
  if (!fanout) {
    const deliveries = new Set<Delivery>();
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      let failure: { error: unknown } | null = null;
      // Whoever subscribes while this event goes out waits for the next one;
      // whoever leaves meanwhile no longer gets it.
      for (const deliver of [...deliveries]) {
        if (!deliveries.has(deliver)) {
          continue;
        }
        try {
          deliver(payload);
        } catch (error) {
          // One pane's failure must not keep the event from the others.
          failure ??= { error };
        }
      }
      if (failure) {
        throw failure.error;
      }
    };
    fanout = { listener, deliveries };
    fanouts.set(channel, fanout);
    ipcRenderer.on(channel, listener);
  }

  // A wrapper of its own: the same callback subscribed twice is two
  // subscriptions, as it was with one ipcRenderer listener each.
  const deliver: Delivery = (payload) => callback(payload as T);
  const current = fanout;
  current.deliveries.add(deliver);
  return () => {
    if (!current.deliveries.delete(deliver) || current.deliveries.size > 0) {
      return;
    }
    ipcRenderer.removeListener(channel, current.listener);
    if (fanouts.get(channel) === current) {
      fanouts.delete(channel);
    }
  };
}

const api: HeadTerminalApi = {
  app: {
    getStartupContext: () => ipcRenderer.invoke(IPC_CHANNELS.app.getStartupContext),
    setTitle: (title) => ipcRenderer.invoke(IPC_CHANNELS.app.setTitle, title),
    requestClose: () => ipcRenderer.invoke(IPC_CHANNELS.app.requestClose),
    respondToClose: (allow) => ipcRenderer.send(IPC_CHANNELS.app.respondToClose, allow),
    onCloseRequested: (callback) =>
      subscribe(IPC_CHANNELS.app.closeRequested, callback),
  },
  terminal: {
    spawn: (input) => ipcRenderer.invoke(IPC_CHANNELS.terminal.spawn, input),
    write: (input) => ipcRenderer.send(IPC_CHANNELS.terminal.write, input),
    resize: (input) => ipcRenderer.send(IPC_CHANNELS.terminal.resize, input),
    kill: (id) => ipcRenderer.invoke(IPC_CHANNELS.terminal.kill, id),
    onData: (callback) =>
      subscribe<PtyDataEvent>(IPC_CHANNELS.terminal.data, callback),
    onExit: (callback) =>
      subscribe<PtyExitEvent>(IPC_CHANNELS.terminal.exit, callback),
  },
  git: {
    getContext: (cwd) => ipcRenderer.invoke(IPC_CHANNELS.git.getContext, cwd),
    getDiff: (cwd) => ipcRenderer.invoke(IPC_CHANNELS.git.getDiff, cwd),
    createWorktree: (cwd, options) =>
      ipcRenderer.invoke(IPC_CHANNELS.git.createWorktree, { cwd, ...options }),
    planWorktree: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.git.planWorktree, input),
    listWorktrees: (cwd) =>
      ipcRenderer.invoke(IPC_CHANNELS.git.listWorktrees, cwd),
    worktreeStatus: (path) =>
      ipcRenderer.invoke(IPC_CHANNELS.git.worktreeStatus, path),
    removeWorktree: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.git.removeWorktree, input),
    watch: (input) => ipcRenderer.invoke(IPC_CHANNELS.git.watch, input),
    unwatch: (watchId) => ipcRenderer.invoke(IPC_CHANNELS.git.unwatch, watchId),
    onChanged: (callback) =>
      subscribe<GitChangedEvent>(IPC_CHANNELS.git.changed, callback),
  },
  system: {
    getDefaultCwd: () => ipcRenderer.invoke(IPC_CHANNELS.system.getDefaultCwd),
    pathExists: (path) => ipcRenderer.invoke(IPC_CHANNELS.system.pathExists, path),
    selectDirectory: (defaultPath) =>
      ipcRenderer.invoke(IPC_CHANNELS.system.selectDirectory, defaultPath),
    selectFile: (defaultPath) =>
      ipcRenderer.invoke(IPC_CHANNELS.system.selectFile, defaultPath),
    confirm: (input) => ipcRenderer.invoke(IPC_CHANNELS.system.confirm, input),
    checkAgentClis: () => ipcRenderer.invoke(IPC_CHANNELS.system.checkAgentClis),
    ensureAgentClis: () => ipcRenderer.invoke(IPC_CHANNELS.system.ensureAgentClis),
    listOllamaModels: () =>
      ipcRenderer.invoke(IPC_CHANNELS.system.listOllamaModels),
    listWslDistros: () =>
      ipcRenderer.invoke(IPC_CHANNELS.system.listWslDistros),
    deleteClaudeProfile: (path) =>
      ipcRenderer.invoke(IPC_CHANNELS.system.deleteClaudeProfile, path),
    getPlatform: () => ipcRenderer.invoke(IPC_CHANNELS.system.getPlatform),
    getResourceUsage: () =>
      ipcRenderer.invoke(IPC_CHANNELS.system.getResourceUsage),
  },
  secrets: {
    has: (key) => ipcRenderer.invoke(IPC_CHANNELS.secrets.has, key),
    set: (key, value) => ipcRenderer.invoke(IPC_CHANNELS.secrets.set, key, value),
    delete: (key) => ipcRenderer.invoke(IPC_CHANNELS.secrets.delete, key),
    getBackendStatus: () =>
      ipcRenderer.invoke(IPC_CHANNELS.secrets.getBackendStatus),
  },
  voice: {
    start: () => ipcRenderer.invoke(IPC_CHANNELS.voice.start),
    stopAndTranscribe: () =>
      ipcRenderer.invoke(IPC_CHANNELS.voice.stopAndTranscribe),
    cancel: () => ipcRenderer.invoke(IPC_CHANNELS.voice.cancel),
    transcribeAudio: (bytes, mimeType) =>
      ipcRenderer.invoke(IPC_CHANNELS.voice.transcribeAudio, bytes, mimeType),
  },
  live: {
    createSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.live.createSession, input),
    delegate: (input) => ipcRenderer.invoke(IPC_CHANNELS.live.delegate, input),
    cancelDelegation: (delegationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.live.cancelDelegation, delegationId),
    onDelegationProgress: (callback) =>
      subscribe<LiveDelegationProgress>(IPC_CHANNELS.live.delegationProgress, callback),
    onToggleRequested: (callback) =>
      subscribe(IPC_CHANNELS.live.toggleRequested, callback),
    onEndRequested: (callback) => subscribe(IPC_CHANNELS.live.endRequested, callback),
  },
  mcp: {
    list: (cwd, agent) => ipcRenderer.invoke(IPC_CHANNELS.mcp.list, cwd, agent),
  },
  sessions: {
    listResumable: (cwd, agent, claudeConfigDir) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.sessions.listResumable,
        cwd,
        agent,
        claudeConfigDir,
      ),
  },
  clipboard: {
    readText: () => ipcRenderer.invoke(IPC_CHANNELS.clipboard.readText),
    writeText: (text) => ipcRenderer.invoke(IPC_CHANNELS.clipboard.writeText, text),
    readForTerminal: () => ipcRenderer.invoke(IPC_CHANNELS.clipboard.readForTerminal),
    importPaths: (paths) =>
      ipcRenderer.invoke(IPC_CHANNELS.clipboard.importPaths, paths),
    saveImage: () => ipcRenderer.invoke(IPC_CHANNELS.clipboard.saveImage),
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file as File);
      } catch {
        const legacy = (file as { path?: unknown } | null)?.path;
        return typeof legacy === "string" ? legacy : "";
      }
    },
  },
  notifications: {
    show: (input) => ipcRenderer.invoke(IPC_CHANNELS.notifications.show, input),
    onActivated: (callback) =>
      subscribe(IPC_CHANNELS.notifications.activated, callback),
  },
  agentHooks: {
    getClaudeSettings: (paneId) =>
      ipcRenderer.invoke(IPC_CHANNELS.agentHooks.getClaudeSettings, paneId),
    onEvent: (callback) =>
      subscribe<AgentHookEventPayload>(IPC_CHANNELS.agentHooks.event, callback),
  },
  diagnostics: {
    appendEvent: (line) => ipcRenderer.send(IPC_CHANNELS.diagnostics.appendEvent, line),
    appendCheckpoint: (input) =>
      ipcRenderer.send(IPC_CHANNELS.diagnostics.appendCheckpoint, input),
    export: (frontend) =>
      ipcRenderer.invoke(IPC_CHANNELS.diagnostics.export, frontend),
  },
  workspace: {
    load: () => ipcRenderer.invoke(IPC_CHANNELS.workspace.load),
    save: (workspace) => ipcRenderer.invoke(IPC_CHANNELS.workspace.save, workspace),
  },
  migration: {
    loadPreferences: () =>
      ipcRenderer.invoke(IPC_CHANNELS.migration.loadPreferences),
  },
};

contextBridge.exposeInMainWorld("headTerminal", Object.freeze(api));
