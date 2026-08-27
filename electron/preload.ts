import { contextBridge, ipcRenderer, webUtils } from "electron";

import { IPC_CHANNELS } from "./ipc/channels";
import type {
  GitChangedEvent,
  HeadTerminalApi,
  PtyDataEvent,
  PtyExitEvent,
  Unsubscribe,
} from "./types/api";

function subscribe<T>(channel: string, callback: (event: T) => void): Unsubscribe {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
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
    createWorktree: (cwd) =>
      ipcRenderer.invoke(IPC_CHANNELS.git.createWorktree, cwd),
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
    confirm: (input) => ipcRenderer.invoke(IPC_CHANNELS.system.confirm, input),
    checkAgentClis: () => ipcRenderer.invoke(IPC_CHANNELS.system.checkAgentClis),
    ensureAgentClis: () => ipcRenderer.invoke(IPC_CHANNELS.system.ensureAgentClis),
    deleteClaudeProfile: (path) =>
      ipcRenderer.invoke(IPC_CHANNELS.system.deleteClaudeProfile, path),
    getPlatform: () => ipcRenderer.invoke(IPC_CHANNELS.system.getPlatform),
    selectWslDistro: (distro) =>
      ipcRenderer.invoke(IPC_CHANNELS.system.selectWslDistro, distro),
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
