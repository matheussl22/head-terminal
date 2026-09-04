import path from "node:path";
import { spawn } from "node:child_process";
import { arch, release } from "node:os";
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
import {
  listResumableSessions,
  resolveAgentSessionRoots,
  type AgentSessionRoots,
} from "./services/agent-sessions-service";
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
import { ensureAgentClis } from "./services/agent-cli-install-service";
import { VoiceService } from "./services/voice-service";
import { WorkspaceService } from "./services/workspace-service";
import { bindWindowsTaskbarLaunch } from "./services/windows-launcher";

/** `os.release()` on Windows is "10.0.26200" (major.minor.build); xterm.js
 * only wants the build number. Undefined on a format it doesn't recognize. */
function parseWindowsBuildNumber(osRelease: string): number | undefined {
  const build = Number(osRelease.split(".")[2]);
  return Number.isFinite(build) ? build : undefined;
}

const RUN_ID = randomUUID().replaceAll("-", "");

if (process.env.HEAD_TERMINAL_USER_DATA) {
  app.setPath("userData", process.env.HEAD_TERMINAL_USER_DATA);
} else if (!app.isPackaged) {
  app.setPath("userData", `${app.getPath("userData")} Dev`);
}

const e2eCdpPort = process.env.HEAD_TERMINAL_E2E_CDP;
if (e2eCdpPort) {
  app.commandLine.appendSwitch("remote-debugging-port", e2eCdpPort);
  app.commandLine.appendSwitch("remote-allow-origins", "*");
}

// Windows silently drops notifications from a process whose AppUserModelId
// does not match the shortcut that launched it. Squirrel derives that id from
// the package and executable names, so the app has to answer to the same one.
if (process.platform === "win32") {
  app.setAppUserModelId(
    app.isPackaged ? "com.squirrel.head-terminal.head-terminal" : "com.matheus.head-terminal",
  );
}

/**
 * Squirrel runs the freshly installed executable with a command instead of a
 * window. Shortcuts are created here and the process exits immediately: an
 * installer that waits on a visible window hangs.
 */
function handledSquirrelCommand(): boolean {
  if (process.platform !== "win32") return false;
  const command = process.argv[1];
  if (typeof command !== "string" || !command.startsWith("--squirrel-")) {
    return false;
  }

  const updateExe = path.resolve(path.dirname(process.execPath), "..", "Update.exe");
  const executable = path.basename(process.execPath);
  const shortcutFlag =
    command === "--squirrel-uninstall" ? "--removeShortcut" : "--createShortcut";

  if (command === "--squirrel-install" || command === "--squirrel-updated"
    || command === "--squirrel-uninstall") {
    try {
      spawn(updateExe, [`${shortcutFlag}=${executable}`], { detached: true })
        .unref();
    } catch {
      // A missing Update.exe means a portable copy: there is no shortcut to
      // manage, and the process must still exit.
    }
  }

  app.quit();
  return true;
}

const gotSingleInstanceLock = handledSquirrelCommand()
  ? false
  : app.requestSingleInstanceLock();

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
  process.on("unhandledRejection", (reason) => { console.error("unhandledRejection", reason); });
  process.on("uncaughtException", (error) => { console.error("uncaughtException", error); app.quit(); });

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

  // ponytail: processo pode sobreviver sem janela; reabre em vez de ignorar o clique
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) openMainWindow();
    else focusMainWindow();
  });

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

  // Everything below this line speaks POSIX. On Windows the distro is
  // resolved once, here, and the boundary is crossed only inside the runner,
  // the PTY wrapper and the session roots.
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
    log(event, meta) {
      diagnostics.appendEvent(JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...meta,
      }));
    },
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
      ensureAgentClis,
      listOllamaModels: systemService.listOllamaModels,
      deleteClaudeProfile: systemService.deleteClaudeProfile,
      getPlatform: () => ({
        platform: process.platform,
        arch: arch(),
        // Profile directories are built from this in the renderer.
        homeDir: systemService.getHome(),
        ...(process.platform === "win32"
          ? {
              // xterm.js uses this to compensate for how ConPTY reflows the
              // screen on redraw/resize, which otherwise conflicts with its
              // own line-wrap tracking and garbles full-screen redraws.
              windowsBuild: parseWindowsBuildNumber(release()),
            }
          : {}),
      }),
      async selectDirectory(window, defaultPath) {
        const result = await dialog.showOpenDialog(window, {
          properties: ["openDirectory", "createDirectory"],
          ...(defaultPath ? { defaultPath } : {}),
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      async selectFile(window, defaultPath) {
        const result = await dialog.showOpenDialog(window, {
          properties: ["openFile"],
          filters: [
            { name: "GGUF", extensions: ["gguf"] },
            { name: "Todos", extensions: ["*"] },
          ],
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
    sessions: {
      listResumable: (cwd, agent, claudeConfigDir) =>
        listResumableSessions(cwd, agent, claudeConfigDir, agentSessionRoots),
    },
    diagnostics,
    workspace,
    migration: {
      loadPreferences: () => migration.loadMigratedPreferences(),
    },
  };

  void ensureAgentClis()
    .then((result) => {
      diagnostics.appendEvent(JSON.stringify({
        ts: new Date().toISOString(),
        event: "agent-cli.ensure",
        installed: result.installed,
        failed: result.failed,
        status: result.status,
      }));
    })
    .catch((error) => {
      diagnostics.appendEvent(JSON.stringify({
        ts: new Date().toISOString(),
        event: "agent-cli.ensure_failed",
        reason: error instanceof Error ? error.message : String(error),
      }));
    });

  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  return {
    services: ipcServices,
    async dispose() {
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
        if (disposed) return;
        disposed = true;
        await pty.dispose();
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

const agentSessionRoots: AgentSessionRoots = resolveAgentSessionRoots();

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  bindWindowsTaskbarLaunch(window);

  const hideWindow = process.env.HEAD_TERMINAL_NO_FOCUS === "1";
  window.once("ready-to-show", () => {
    if (!hideWindow) window.show();
  });
  window.webContents.once("did-finish-load", () => {
    // Some virtual displays and GPU-less Linux sessions never emit
    // ready-to-show even though the renderer is fully loaded.
    if (!hideWindow && !window.isDestroyed() && !window.isVisible()) {
      window.show();
    }
    if (process.env.HEAD_TERMINAL_SMOKE === "1" || hideWindow) {
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
    ? "default-src 'self' http://localhost:*; script-src 'self' 'unsafe-inline' http://localhost:*; style-src 'self' 'unsafe-inline' http://localhost:*; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://localhost:* ws://localhost:*; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
  // Everything stays denied except the microphone, and only for the app's own
  // window: voice input records through Chromium because the main process has
  // no recorder to spawn on Windows. Video is never granted.
  const isOwnWindow = (contents: Electron.WebContents | null): boolean =>
    contents !== null && BrowserWindow.fromWebContents(contents) !== null;

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      if (!isOwnWindow(webContents) || permission !== "media") {
        callback(false);
        return;
      }
      const { mediaTypes } = details as Electron.MediaAccessPermissionRequest;
      callback((mediaTypes ?? ["audio"]).every((type) => type === "audio"));
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, _origin, details) =>
      isOwnWindow(webContents)
      && permission === "media"
      && details.mediaType === "audio",
  );
}
