import path from "node:path";
import { spawn } from "node:child_process";
import { arch, release } from "node:os";
import { randomUUID } from "node:crypto";

import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  net,
  safeStorage,
  session,
  shell,
  systemPreferences,
  webContents,
} from "electron";

import {
  chooseLocale,
  isLocale,
  locale,
  msg,
  setLocale,
  type Locale,
} from "../src/i18n";
import { IPC_CHANNELS, LOCALE_ARGUMENT } from "./ipc/channels";
import { registerIpc, type IpcServices } from "./ipc/register";
import { buildMacApplicationMenu } from "./mac-menu";
import { adoptLoginShellPath } from "./services/shell-env";
import { AgentHookServer } from "./services/agent-hook-server";
import { FolderInbox, resolveOpenedFolder } from "./services/folder-inbox";
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
import { PtyService, type PtyServiceEvent } from "./services/pty-service";
import { readLanguagePreference } from "./services/language-preference";
import { systemLanguages } from "./system-languages";
import { getResourceUsage } from "./services/resource-usage-service";
import { ClaudeUsageAdapter } from "./services/claude-usage";
import { CodexUsageAdapter } from "./services/codex-usage";
import { CursorUsageAdapter } from "./services/cursor-usage";
import { UsageService } from "./services/usage-service";
import { SecretService } from "./services/secret-service";
import * as systemService from "./services/system-service";
import { ensureAgentClis } from "./services/agent-cli-install-service";
import { LiveBrainstormService } from "./services/live-brainstorm-service";
import { VoiceService } from "./services/voice-service";
import { RemoteBridge } from "./services/remote-bridge";
import { RemoteServer } from "./services/remote/remote-server";
import { WorkspaceService } from "./services/workspace-service";
import { bindWindowsTaskbarLaunch } from "./services/windows-launcher";
import { AGENT_HOOK_PANE_ENV } from "../src/types/agent-hooks";

/** `os.release()` on Windows is "10.0.26200" (major.minor.build); xterm.js
 * only wants the build number. Undefined on a format it doesn't recognize. */
function parseWindowsBuildNumber(osRelease: string): number | undefined {
  const build = Number(osRelease.split(".")[2]);
  return Number.isFinite(build) ? build : undefined;
}

const RUN_ID = randomUUID().replaceAll("-", "");

/**
 * The UI language: the one picked in Settings, or — on "auto" — the
 * machine's first preferred language the app speaks, Portuguese when it
 * speaks none of them. `HEAD_TERMINAL_LOCALE` pins it (`en` / `pt-BR`), for
 * development and tests.
 */
function resolveAppLocale(): Locale {
  const pinned = process.env.HEAD_TERMINAL_LOCALE;
  if (isLocale(pinned)) {
    return pinned;
  }
  return chooseLocale(readLanguagePreference(app.getPath("userData")), systemLanguages());
}

/**
 * Switches main's language: at startup, and again when Settings picks
 * another one. Dialogs and notifications read `msg` when shown; the menu is
 * built once, so it is built again in the new language.
 */
function applyLocale(next: Locale): void {
  setLocale(next);
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      buildMacApplicationMenu({ appName: app.name, development: !app.isPackaged }),
    );
  }
}

const PTY_EVENT_CHANNELS: Record<PtyServiceEvent["channel"], string> = {
  "pty:data": IPC_CHANNELS.terminal.data,
  "pty:exit": IPC_CHANNELS.terminal.exit,
  "pty:agent": IPC_CHANNELS.terminal.agent,
};

/** System Settings › Privacy & Security › Microphone, as a URL macOS opens. */
const MAC_MICROPHONE_PRIVACY_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

if (process.env.HEAD_TERMINAL_USER_DATA) {
  app.setPath("userData", process.env.HEAD_TERMINAL_USER_DATA);
} else if (!app.isPackaged) {
  app.setPath("userData", `${app.getPath("userData")} Dev`);
}

// Started from inside another Head Terminal pane (developing the app in the
// app), the process inherits that pane's id. The hooks no longer route by it
// (each pane's settings file carries its own id), but it has no business in
// the panes and CLIs this instance starts.
delete process.env[AGENT_HOOK_PANE_ENV];

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
  /** macOS only: ⌘Q was turned into a window close that is still pending. */
  let quitAfterWindowClose = false;
  let disposeServices: (() => Promise<void>) | null = null;
  let services: IpcServices | null = null;
  const folderInbox = new FolderInbox();

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
    const window = createMainWindow();
    mainWindow = window;
    const unregisterIpc = registerIpc({
      window,
      services,
      isQuitting: () => isQuitting,
      runId: RUN_ID,
      onLocaleChange: applyLocale,
      takePendingFolder: (deliver) => folderInbox.attach(deliver),
    });
    // On macOS the app outlives its window (closed from the red button, back
    // from the Dock): drop the IPC bindings and the reference, so `activate`
    // and `second-instance` open a fresh window instead of focusing a ghost.
    window.once("closed", () => {
      unregisterIpc();
      folderInbox.detach();
      if (mainWindow === window) mainWindow = null;
      // The window was closed on the way out of ⌘Q; now the quit can proceed.
      if (quitAfterWindowClose) {
        quitAfterWindowClose = false;
        app.quit();
      }
    });
    loadRenderer(window);
  };

  // A folder sent from outside: Finder's "New Head Terminal Session Here"
  // (scripts/install-finder-service.sh) or a folder dropped on the Dock icon.
  // `open -a` delivers it as `open-file` — on a cold launch before `ready` —
  // so the listener goes up now, and the inbox holds the folder until the
  // renderer asks for it: it opens the new-session dialog there.
  app.on("open-file", (event, target) => {
    // Handled here; left alone, AppKit answers with a "could not be opened" alert.
    event.preventDefault();
    void resolveOpenedFolder(target).then((folder) => {
      const kept = folder !== null && !folderInbox.receive(folder);
      // Running without a window (closed from the red button): one opens to
      // take the folder. Before `ready`, the startup window takes it.
      if (kept && services && (!mainWindow || mainWindow.isDestroyed())) openMainWindow();
      else focusMainWindow();
    });
  });

  // ponytail: processo pode sobreviver sem janela; reabre em vez de ignorar o clique
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) openMainWindow();
    else focusMainWindow();
  });

  void app.whenReady().then(async () => {
    // Before the menu, any dialog or the window: all of them speak it.
    applyLocale(resolveAppLocale());
    if (process.platform === "darwin") {
      // Before any service spawns a CLI or a pane inherits process.env: a
      // Finder/Dock launch carries launchd's PATH, not the user's shell's.
      await adoptLoginShellPath();
    }
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
    // On Windows and Linux a quit only ever follows the window closing, and
    // closing is where the renderer confirms running agents, reviews
    // worktrees and flushes the workspace. On macOS ⌘Q arrives with the
    // window still open, so it is routed through that same close: the window
    // asks the renderer, and once it is actually gone (`closed` above) the
    // quit is requested again and lands in the shutdown below. A cancelled
    // close simply leaves the app running.
    if (
      process.platform === "darwin"
      && !shutdownStarted
      && mainWindow
      && !mainWindow.isDestroyed()
    ) {
      event.preventDefault();
      quitAfterWindowClose = true;
      mainWindow.close();
      return;
    }
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
      owner.send(PTY_EVENT_CHANNELS[event.channel], event.payload);
    },
  });
  const git = createGitService();
  const voice = new VoiceService({ secrets });
  const live = new LiveBrainstormService({ secrets, homeDir: systemService.getHome() });
  const mcp = new McpService();
  const home = () => systemService.getHome();
  const usage = new UsageService({
    adapters: {
      claude: new ClaudeUsageAdapter({ home }),
      codex: new CodexUsageAdapter({ home }),
      cursor: new CursorUsageAdapter({ home }),
    },
    // net.fetch goes through the system proxy, like the rest of Chromium.
    fetch: (url, init) => net.fetch(url, init),
    userAgent: `HeadTerminal/${app.getVersion()}`,
  });
  const agentHooks = new AgentHookServer({
    userDataPath,
    log(event, meta) {
      diagnostics.appendEvent(JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...meta,
      }));
    },
  });
  // Up before the renderer asks for it: the server, the pane files and the
  // `claude --version` probe all happen in the background, so a restored
  // Claude pane finds them ready instead of waiting on them.
  void agentHooks.warmUp().catch(() => undefined);

  // The phone remote: off until Settings turns it on, then back on at every
  // start. Smoke and E2E runs never open a LAN port.
  const remoteBridge = new RemoteBridge(
    (bytes, mimeType) => voice.transcribeAudio(bytes, mimeType),
    () => msg.main.remote.windowClosed,
  );
  const remoteServer = new RemoteServer({
    host: remoteBridge,
    userDataPath,
    // Tests and development pin it to loopback: no LAN port, no firewall prompt.
    ...(process.env.HEAD_TERMINAL_REMOTE_BIND
      ? { bindAddress: process.env.HEAD_TERMINAL_REMOTE_BIND }
      : {}),
    log(event, meta) {
      diagnostics.appendEvent(JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...meta,
      }));
    },
  });
  if (!smokeTest && !process.env.HEAD_TERMINAL_E2E_CDP) {
    void remoteServer.init().catch((error) => {
      diagnostics.appendEvent(JSON.stringify({
        ts: new Date().toISOString(),
        event: "remote.init_failed",
        reason: error instanceof Error ? error.message : String(error),
      }));
    });
  }

  const ipcServices: IpcServices = {
    terminal: pty,
    git,
    system: {
      getDefaultCwd: systemService.getDefaultCwd,
      pathExists: systemService.pathExists,
      checkAgentClis: systemService.checkAgentClis,
      ensureAgentClis,
      listOllamaModels: systemService.listOllamaModels,
      listWslDistros: () => systemService.listWslDistros(),
      deleteClaudeProfile: systemService.deleteClaudeProfile,
      getResourceUsage,
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
            { name: msg.main.dialog.allFiles, extensions: ["*"] },
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
          buttons: [
            input.confirmLabel ?? msg.main.dialog.confirm,
            input.cancelLabel ?? msg.main.dialog.cancel,
          ],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        return result.response === 0;
      },
    },
    secrets,
    voice,
    live,
    mcp,
    usage,
    sessions: {
      listResumable: (cwd, agent, claudeConfigDir) =>
        listResumableSessions(cwd, agent, claudeConfigDir, agentSessionRoots),
    },
    diagnostics,
    workspace,
    migration: {
      loadPreferences: () => migration.loadMigratedPreferences(),
    },
    agentHooks,
    remote: {
      status: () => remoteServer.status(),
      setEnabled: (enabled) => remoteServer.setEnabled(enabled),
      regeneratePin: () => remoteServer.regeneratePin(),
      revokeDevice: (id) => remoteServer.revokeDevice(id),
      revokeAllDevices: () => remoteServer.revokeAllDevices(),
      onStatus: (listener) => remoteServer.onStatus(listener),
      publishState: (snapshot) => remoteBridge.publishState(snapshot),
      publishScreen: (screen) => remoteBridge.publishScreen(screen),
      replyCommand: (reply) => remoteBridge.replyCommand(reply),
      attachRenderer: (renderer) => remoteBridge.attachRenderer(renderer),
      watchedPanes: () => remoteBridge.watchedPanes(),
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
        await agentHooks.close();
        await remoteServer.close().catch(() => undefined);
        await Promise.all([
          voice.dispose(),
          live.dispose(),
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
      // The preload reads it synchronously, so the renderer's modules load
      // already knowing which language their label tables are in.
      additionalArguments: [`${LOCALE_ARGUMENT}${locale}`],
      // The pane status is derived in the renderer from PTY output and agent
      // hooks, and it fires the "needs you" notifications. A throttled
      // renderer (window minimized or covered) would fall behind exactly when
      // the user relies on those notifications.
      backgroundThrottling: false,
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
  // no recorder to spawn on Windows or macOS. Video is never granted.
  const isOwnWindow = (contents: Electron.WebContents | null): boolean =>
    contents !== null && BrowserWindow.fromWebContents(contents) !== null;

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      if (!isOwnWindow(webContents) || permission !== "media") {
        callback(false);
        return;
      }
      const { mediaTypes } = details as Electron.MediaAccessPermissionRequest;
      const audioOnly = (mediaTypes ?? ["audio"]).every((type) => type === "audio");
      if (!audioOnly) {
        callback(false);
        return;
      }
      // macOS gates the microphone behind TCC: the system prompt has to be
      // answered before Chromium may open the device, or capture fails
      // silently. The packaged app declares NSMicrophoneUsageDescription in
      // forge.config.ts for this prompt to exist at all.
      if (process.platform === "darwin") {
        // Once denied, macOS never prompts again and askForMediaAccess just
        // answers false: the only way back is the Privacy pane, so open it
        // where the user can flip the switch instead of failing silently.
        if (systemPreferences.getMediaAccessStatus("microphone") === "denied") {
          callback(false);
          void shell.openExternal(MAC_MICROPHONE_PRIVACY_PANE).catch(() => undefined);
          return;
        }
        void systemPreferences
          .askForMediaAccess("microphone")
          .then((granted) => callback(granted), () => callback(false));
        return;
      }
      callback(true);
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, _origin, details) =>
      isOwnWindow(webContents)
      && permission === "media"
      && details.mediaType === "audio",
  );
}
