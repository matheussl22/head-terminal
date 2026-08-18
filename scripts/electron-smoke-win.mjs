#!/usr/bin/env node
// Windows counterpart of electron-smoke.sh. Same contract — a visible window
// and a real PTY — with the X11 half replaced by the Win32 one: there is no
// Xvfb and no xdotool, so the window is read back through PowerShell.
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const TIMEOUT_MS =
  Number(process.env.HEAD_TERMINAL_SMOKE_TIMEOUT_SECONDS ?? 60) * 1_000;
const APP_BINARY =
  process.env.HEAD_TERMINAL_SMOKE_BINARY
  ?? join(process.cwd(), "out", "Head Terminal-win32-x64", "head-terminal.exe");

function mainWindowTitle(pid) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowTitle`,
      ],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
      (error, stdout) => resolve(error ? "" : stdout.trim()),
    );
  });
}

async function main() {
  if (process.platform !== "win32") {
    console.log("SKIP electron smoke: not running on Windows");
    return;
  }

  const workDir = await mkdtemp(join(tmpdir(), "head-terminal-smoke-"));
  const logPath = join(workDir, "app.log");
  const log = createWriteStream(logPath);
  const child = spawn(
    APP_BINARY,
    [
      "--disable-gpu",
      "--enable-logging=stderr",
      `--user-data-dir=${join(workDir, "user-data")}`,
    ],
    {
      env: {
        ...process.env,
        HEAD_TERMINAL_CHANNEL: "smoke",
        HEAD_TERMINAL_SMOKE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);

  let exited = false;
  child.on("exit", () => (exited = true));
  const childExit = once(child, "exit").catch(() => undefined);

  const deadline = Date.now() + TIMEOUT_MS;
  let title = "";
  let ptyReady = false;

  try {
    while (Date.now() < deadline && !ptyReady) {
      if (exited) throw new Error("Electron exited before presenting its window");
      if (!title) title = await mainWindowTitle(child.pid);

      const logs = await readFile(logPath, "utf8").catch(() => "");
      if (/js\.pty\.spawn_failed|node-pty is unavailable/u.test(logs)) {
        throw new Error("Packaged renderer failed to create its PTY");
      }
      ptyReady = /js\.pty\.spawn_ok/u.test(logs);
      if (!ptyReady) await delay(250);
    }

    if (!title) throw new Error("Timed out waiting for the Electron main window");
    if (!ptyReady) throw new Error("Timed out waiting for packaged PTY startup");
    console.log(`SMOKE_OK pid=${child.pid} title=${title} pty=ready`);
  } catch (error) {
    console.error(await readFile(logPath, "utf8").catch(() => ""));
    process.exitCode = 1;
    console.error(String(error instanceof Error ? error.message : error));
    return;
  } finally {
    if (!exited) child.kill();
    log.close();
    // Windows holds the user-data files open until the process is really gone,
    // so cleanup waits for the exit and still retries past a lingering lock. A
    // leftover temp directory is not a product failure and must never turn a
    // passing smoke into a red one.
    await childExit;
    if (process.exitCode !== 1) {
      await rm(workDir, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 250,
      }).catch((error) => console.warn(`smoke cleanup left ${workDir}: ${error}`));
    }
  }
}

await main();
