import { existsSync } from "node:fs";
import path from "node:path";

import { app, shell, type BrowserWindow } from "electron";

const DEV_AUMID = "com.matheus.head-terminal";
const PACKAGED_AUMID = "com.squirrel.head-terminal.head-terminal";

function projectRoot(): string {
  return path.resolve(__dirname, "../..");
}

function devLauncherPath(): string {
  return path.join(projectRoot(), "scripts", "head-terminal-dev.vbs");
}

function wscriptPath(): string {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
}

export function windowsAppUserModelId(): string {
  return app.isPackaged ? PACKAGED_AUMID : DEV_AUMID;
}

export function windowsRelaunchCommand(): string | null {
  if (process.platform !== "win32") {
    return null;
  }
  if (app.isPackaged) {
    return `"${process.execPath}"`;
  }
  const launcher = devLauncherPath();
  if (!existsSync(launcher)) {
    return null;
  }
  return `"${wscriptPath()}" "${launcher}"`;
}

function writeDevShortcut(shortcutPath: string): void {
  const launcher = devLauncherPath();
  const electronIcon = path.join(
    projectRoot(),
    "node_modules",
    "electron",
    "dist",
    "electron.exe",
  );
  const options: Electron.ShortcutDetails = {
    target: wscriptPath(),
    args: `"${launcher}"`,
    cwd: projectRoot(),
    description: "Head Terminal (Dev)",
    appUserModelId: DEV_AUMID,
    ...(existsSync(electronIcon) ? { icon: electronIcon, iconIndex: 0 } : {}),
  };
  if (!shell.writeShortcutLink(shortcutPath, "replace", options)) {
    shell.writeShortcutLink(shortcutPath, "create", options);
  }
}

/**
 * Windows pins whatever launched the process. `npm run dev` is electron.exe
 * with no app path, so a taskbar pin opens the default Electron page.
 * A Start Menu shortcut with our AUMID + relaunch command is what the pin
 * should follow instead.
 */
export function bindWindowsTaskbarLaunch(window: BrowserWindow): void {
  if (process.platform !== "win32") {
    return;
  }
  const relaunch = windowsRelaunchCommand();
  const appId = windowsAppUserModelId();
  if (relaunch) {
    window.setAppDetails({
      appId,
      relaunchCommand: relaunch,
      relaunchDisplayName: app.isPackaged ? "Head Terminal" : "Head Terminal (Dev)",
    });
  }
  if (app.isPackaged || process.env.HEAD_TERMINAL_SMOKE === "1") {
    return;
  }
  if (!existsSync(devLauncherPath()) || !relaunch) {
    return;
  }
  const name = "Head Terminal (Dev).lnk";
  writeDevShortcut(
    path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", name),
  );
  writeDevShortcut(path.join(app.getPath("desktop"), name));
}
