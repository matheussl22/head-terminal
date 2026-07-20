import path from "node:path";
import { arch, homedir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  app,
  BrowserWindow,
  dialog,
  safeStorage,
  session,
  shell,
  webContents,
} from "electron";

import { IPC_CHANNELS } from "./ipc/channels";
import { registerIpc, type IpcServices } from "./ipc/register";
import { DiagnosticService } from "./services/diagnostic-service";
import { createGitService } from "./services/git-watch-service";
import { McpService } from "./services/mcp-service";
import {
  defaultLegacyDatabasePaths,
  MigrationService,
  readWebKitLocalStorageDatabase,
} from "./services/migration-service";
import { PtyService } from "./services/pty-service";
import { SecretService } from "./services/secret-service";
import * as systemService from "./services/system-service";
import { VoiceService } from "./services/voice-service";
import { WorkspaceService } from "./services/workspace-service";

const RUN_ID = randomUUID().replaceAll("-", "");

if (!app.isPackaged) {
  app.setPath("userData", `${app.getPath("userData")} Dev`);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let isQuitting = false;
  let shutdownComplete = false;
  let shutdownStarted = false;
  let disposeServices: (() => Promise<void>) | null = null;
  let services: IpcServices | null = null;

  const requestSignalShutdown = () => app.quit();
  process.on("SIGTERM", requestSignalShutdown);
  process.on("SIGINT", requestSignalShutdown);

  const focusMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };

  const openMainWindow = () => {
    if (!services) return;
    mainWindow = createMainWindow();
    registerIpc({
      window: mainWindow,
      services,
      isQuitting: () => isQuitting,
      runId: RUN_ID,
    });
    loadRenderer(mainWindow);
  };

  app.on("second-instance", focusMainWindow);

  void app.whenReady().then(async () => {
    installContentSecurityPolicy();
    const initialized = await createServices();
    services = initialized.services;
    disposeServices = initialized.dispose;
    openMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
      else focusMainWindow();
    });
  }).catch((error) => {
    console.error("Failed to initialize Head Terminal", error);
    app.quit();
  });

  app.on("before-quit", (event) => {
    isQuitting = true;
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void (disposeServices?.() ?? Promise.resolve())
      .catch((error) => console.error("Shutdown cleanup failed", error))
      .finally(() => {
        shutdownComplete = true;
        app.quit();
      });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

async function createServices(): Promise<{
  services: IpcServices;
  dispose: () => Promise<void>;
}> {
  const userDataPath = app.getPath("userData");
  const channel = app.isPackaged ? "prod" : "dev";
  const smokeTest = process.env.HEAD_TERMINAL_SMOKE === "1";
  const diagnostics = new DiagnosticService({ channel, runId: RUN_ID });
  const workspace = new WorkspaceService({ userDataPath, channel });
  const migration = new MigrationService({
    userDataPath,
    workspaceService: workspace,
    channel,
    ...(smokeTest
      ? {
          sourcePath: path.join(userDataPath, "smoke-no-migration.json"),
          legacyDatabasePaths: [],
        }
      : {}),
  });

  const migrationResult = await migration.importIfAvailable();
  diagnostics.appendEvent(JSON.stringify({
    ts: new Date().toISOString(),
    event: "migration.completed",
    status: migrationResult.status,
    workspaceImported: migrationResult.workspaceImported,
    preferenceCount: migrationResult.preferenceCount,
  }));

  const legacyDatabasePaths = smokeTest ? [] : defaultLegacyDatabasePaths(channel);
  const secrets = new SecretService({
    userDataPath,
    safeStorage,
    importLegacyOpenAiKey: async () => {
      for (const databasePath of legacyDatabasePaths) {
        const values = await readWebKitLocalStorageDatabase(databasePath);
        const value = values?.["head-terminal.openai-api-key"];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return null;
    },
  });
  // Import only through safeStorage. On Linux basic_text is intentionally
  // rejected by SecretService and must not prevent the app from starting.
  await secrets.importLegacyOpenAiKey().catch((error) => {
    diagnostics.appendEvent(JSON.stringify({
      ts: new Date().toISOString(),
      event: "migration.secret_skipped",
      reason: error instanceof Error ? error.message : String(error),
    }));
  });

  const pty = new PtyService({
    emit(event) {
      const owner = webContents.fromId(event.ownerId);
      if (!owner || owner.isDestroyed()) return;
      owner.send(
        event.channel === "pty:data"
          ? IPC_CHANNELS.terminal.data
          : IPC_CHANNELS.terminal.exit,
        event.payload,
      );
    },
  });
  const git = createGitService();
  const voice = new VoiceService({ secrets });
  const mcp = new McpService();

  const ipcServices: IpcServices = {
    terminal: pty,
    git,
    system: {
      getDefaultCwd: systemService.getDefaultCwd,
      pathExists: systemService.pathExists,
      checkAgentClis: systemService.checkAgentClis,
      deleteClaudeProfile: systemService.deleteClaudeProfile,
      getPlatform: () => ({
        platform: process.platform,
        arch: arch(),
        homeDir: homedir(),
      }),
      async selectDirectory(window, defaultPath) {
        const result = await dialog.showOpenDialog(window, {
          properties: ["openDirectory", "createDirectory"],
          ...(defaultPath ? { defaultPath } : {}),
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      async confirm(window, input) {
        const result = await dialog.showMessageBox(window, {
          type: "question",
          title: input.title ?? "Head Terminal",
          message: input.message,
          detail: input.detail,
          buttons: [input.confirmLabel ?? "Confirmar", input.cancelLabel ?? "Cancelar"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        return result.response === 0;
      },
    },
    secrets,
    voice,
    mcp,
    diagnostics,
    workspace,
    migration: {
      loadPreferences: () => migration.loadMigratedPreferences(),
    },
  };

  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  return {
    services: ipcServices,
    async dispose() {
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
        if (disposed) return;
        disposed = true;
        pty.dispose();
        git.dispose();
        await Promise.all([
          voice.dispose(),
          diagnostics.flush(),
          workspace.flush(),
          secrets.flush(),
        ]);
      })();
      return disposePromise;
    },
  };
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.once("did-finish-load", () => {
    // Some virtual displays and GPU-less Linux sessions never emit
    // ready-to-show even though the renderer is fully loaded.
    if (!window.isDestroyed() && !window.isVisible()) window.show();
    if (process.env.HEAD_TERMINAL_SMOKE === "1") {
      console.info("HEAD_TERMINAL_RENDERER_READY");
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  return window;
}

function loadRenderer(window: BrowserWindow): void {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const protocol = new URL(rawUrl).protocol;
    return protocol === "https:" || protocol === "http:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

function installContentSecurityPolicy(): void {
  const isDevelopment = Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  const policy = isDevelopment
    ? "default-src 'self' http://localhost:*; script-src 'self' http://localhost:*; style-src 'self' 'unsafe-inline' http://localhost:*; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://localhost:* ws://localhost:*; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
}
