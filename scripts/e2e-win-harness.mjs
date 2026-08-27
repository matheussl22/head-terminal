#!/usr/bin/env node
// Shared Windows CDP helpers for Head Terminal e2e (dev + smoke pane).
import { execFile, spawn } from "node:child_process";
import { appendFileSync, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const CDP_PORT = process.env.HEAD_TERMINAL_E2E_CDP ?? "9339";
export const BOOT_TIMEOUT_MS = Number(
  process.env.HEAD_TERMINAL_E2E_TIMEOUT_MS ?? 180_000,
);
export const EVALUATE_TIMEOUT_MS = 15_000;
export const PROJECT_DIR = process.cwd();

export function fail(message) {
  throw new Error(message);
}

export function toPosixPath(windows) {
  const drive = /^([A-Za-z]):[\\/](.*)$/u.exec(windows);
  if (drive) {
    const rest = drive[2].replaceAll("\\", "/");
    return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
  }
  return windows.replaceAll("\\", "/");
}

export const PROJECT_POSIX = toPosixPath(PROJECT_DIR);

export function powershell(command) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-NonInteractive", "-Command", command],
      { encoding: "utf8", timeout: 20_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

export function putFileOnClipboard(windowsPath) {
  const escaped = windowsPath.replaceAll("'", "''");
  return powershell(`Set-Clipboard -Path '${escaped}'; 'ok'`);
}

export function putBitmapOnClipboard() {
  return powershell(`
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Windows.Forms
    $bmp = New-Object System.Drawing.Bitmap 16, 10
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::DeepPink)
    $g.Dispose()
    [System.Windows.Forms.Clipboard]::SetImage($bmp)
    $bmp.Dispose()
    'ok'
  `);
}

export function makeDebug(debugPath) {
  return (line) => {
    const entry = `${new Date().toISOString()} ${line}\n`;
    appendFileSync(debugPath, entry);
    process.stdout.write(entry);
  };
}

export async function waitForCdp(port, deadline, debug) {
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        last = JSON.stringify(targets.map((target) => ({
          type: target.type,
          url: target.url,
          title: target.title,
        })));
        debug(`cdp targets ${last}`);
        const page = targets.find(
          (target) =>
            target.type === "page"
            && typeof target.webSocketDebuggerUrl === "string"
            && !target.url.startsWith("devtools:")
            && !target.url.startsWith("chrome-extension:"),
        );
        if (page) return page;
      }
    } catch (error) {
      debug(`cdp poll ${error instanceof Error ? error.message : error}`);
    }
    await delay(250);
  }
  fail(`CDP on port ${port} never exposed a renderer page. last=${last}`);
}

export async function waitForCdpGone(port, deadline, debug) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) {
        return;
      }
    } catch {
      return;
    }
    await delay(250);
  }
  debug(`cdp port ${port} still answering after kill`);
}

export function cdpSession(webSocketDebuggerUrl) {
  if (typeof WebSocket === "undefined") {
    fail("This Node build has no WebSocket; need Node 22+");
  }
  const ws = new WebSocket(webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed")));
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(
        new Error(message.error.message ?? JSON.stringify(message.error)),
      );
      return;
    }
    waiter.resolve(message.result);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        // The renderer may already be gone.
      }
    },
  };
}

export async function evaluate(cdp, expression, awaitPromise = false) {
  const result = await Promise.race([
    cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    }),
    delay(EVALUATE_TIMEOUT_MS).then(() => {
      throw new Error(`CDP evaluate timed out: ${expression.slice(0, 80)}`);
    }),
  ]);
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? "Runtime.evaluate threw";
    fail(text);
  }
  return result.result?.value;
}

export function killTree(pid) {
  return new Promise((resolve) => {
    execFile(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true },
      () => resolve(),
    );
  });
}

export function spawnDev({ userData, logPath, cdpPort = CDP_PORT }) {
  const log = createWriteStream(logPath, { flags: "a" });
  const child = spawn("npm.cmd", ["run", "dev"], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      NODE_ENV: "development",
      HEAD_TERMINAL_SMOKE: "1",
      HEAD_TERMINAL_CHANNEL: "smoke",
      HEAD_TERMINAL_USER_DATA: userData,
      HEAD_TERMINAL_E2E_CDP: String(cdpPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: true,
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const state = { exited: false, exitCode: null };
  child.on("exit", (code) => {
    state.exited = true;
    state.exitCode = code;
  });
  return { child, log, state };
}

export async function connectRenderer({ child, state, debug, cdpPort = CDP_PORT }) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  const page = await waitForCdp(cdpPort, deadline, debug);
  debug(`page ${page.url} ${page.title}`);
  if (state.exited) fail("Electron exited before CDP was ready");
  const cdp = cdpSession(page.webSocketDebuggerUrl);
  await cdp.ready;
  debug("cdp websocket open");
  await cdp.send("Runtime.enable");
  debug("runtime enabled");
  await waitForPaneReady(cdp, deadline, debug);
  return cdp;
}

export async function waitForPaneReady(cdp, deadline, debug) {
  while (Date.now() < deadline) {
    const ready = await evaluate(
      cdp,
      `Boolean(document.querySelector(".terminal-pane") && document.querySelector(".xterm") && window.headTerminal)`,
    );
    if (ready) {
      debug("paneReady=true");
      return;
    }
    await delay(250);
  }
  const paneReady = await evaluate(
    cdp,
    `Boolean(document.querySelector(".terminal-pane") && document.querySelector(".xterm"))`,
  );
  debug(`paneReady=${paneReady}`);
  if (!paneReady) fail("Renderer never mounted a terminal pane");
}

export async function poll(cdp, expression, options = {}) {
  const timeout = options.timeout ?? 15_000;
  const interval = options.interval ?? 200;
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, expression, Boolean(options.awaitPromise));
    if (options.predicate ? options.predicate(last) : Boolean(last)) {
      return last;
    }
    await delay(interval);
  }
  fail(
    `poll timeout (${timeout}ms): ${expression.slice(0, 120)}\nlast=${JSON.stringify(last)}`,
  );
}

export async function click(cdp, selector) {
  const ok = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`,
  );
  if (!ok) fail(`click missed selector: ${selector}`);
}

export async function clickWhen(cdp, selector, options = {}) {
  await poll(cdp, `Boolean(document.querySelector(${JSON.stringify(selector)}))`, options);
  await click(cdp, selector);
}

export async function clickByText(cdp, selector, text) {
  const ok = await evaluate(
    cdp,
    `(() => {
      const needle = ${JSON.stringify(text)};
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((node) => (node.textContent || "").includes(needle));
      if (!el) return false;
      el.click();
      return true;
    })()`,
  );
  if (!ok) fail(`clickByText missed ${selector} text=${JSON.stringify(text)}`);
}

export async function setInputValue(cdp, selector, value) {
  const ok = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
        return false;
      }
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      desc.set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`,
  );
  if (!ok) fail(`setInputValue missed: ${selector}`);
}

export async function dispatchKey(cdp, key, mods = {}) {
  await evaluate(
    cdp,
    `(() => {
      document.activeElement?.blur();
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: ${JSON.stringify(key)},
        code: ${JSON.stringify(mods.code ?? key)},
        ctrlKey: ${Boolean(mods.ctrl)},
        shiftKey: ${Boolean(mods.shift)},
        altKey: ${Boolean(mods.alt)},
        metaKey: false,
        bubbles: true,
        cancelable: true,
      }));
      return true;
    })()`,
  );
}

export async function snapshot(cdp) {
  return evaluate(
    cdp,
    `(() => ({
      sessionCount: document.querySelectorAll("[data-session-id]").length,
      sessions: [...document.querySelectorAll("[data-session-id]")].map((el) => ({
        id: el.dataset.sessionId,
        title: el.querySelector(".session-sidebar__title")?.textContent?.trim()
          ?? el.querySelector("[aria-label]")?.getAttribute("aria-label")
          ?? "",
        active: Boolean(
          el.querySelector(".session-sidebar__item--active")
          || el.querySelector(".session-sidebar__compact-item--active"),
        ),
      })),
      visiblePanes: document.querySelectorAll(
        ".session-workspace--visible .terminal-pane-shell",
      ).length,
      allPanes: document.querySelectorAll(".terminal-pane-shell").length,
      dividers: document.querySelectorAll(".layout-divider").length,
      gitBadge: Boolean(document.querySelector(".git-branch-badge")),
      statusBar: Boolean(document.querySelector(".terminal-status-bar")),
      dialogs: {
        create: Boolean(document.querySelector(".create-session-dialog")),
        settings: Boolean(document.querySelector(".settings-dialog")),
        palette: Boolean(document.querySelector(".command-palette")),
        diff: Boolean(document.querySelector(".session-diff")),
      },
      nova: Boolean(document.querySelector(".session-sidebar__new")),
      splitVertical: Boolean(
        document.querySelector('[aria-label="Dividir verticalmente"]'),
      ),
      splitHorizontal: Boolean(
        document.querySelector('[aria-label="Dividir horizontalmente"]'),
      ),
    }))()`,
  );
}

export async function dumpFailure({ debug, logPath, extraLogPaths = [], cdp }) {
  if (cdp) {
    try {
      debug(`dom snapshot ${JSON.stringify(await snapshot(cdp))}`);
    } catch (error) {
      debug(`snapshot failed ${error instanceof Error ? error.message : error}`);
    }
  }
  const logs = [logPath, ...extraLogPaths];
  for (const path of logs) {
    try {
      const text = await readFile(path, "utf8");
      console.error(`--- ${path} (last 8k) ---`);
      console.error(text.slice(-8_000));
    } catch {
      console.error(`--- ${path} unreadable ---`);
    }
  }
}

export async function stopApp({ cdp, child, state }) {
  cdp?.close();
  if (!state.exited && child.pid) {
    await killTree(child.pid);
  }
  await waitForCdpGone(CDP_PORT, Date.now() + 15_000, () => undefined);
  await delay(500);
}

export async function withWorkDir(callback) {
  const workDir = await mkdtemp(join(tmpdir(), "head-terminal-e2e-"));
  const debugPath = join(workDir, "e2e-debug.log");
  const debug = makeDebug(debugPath);
  debug(`workDir=${workDir}`);
  const userData = join(workDir, "user-data");
  let keep = false;
  try {
    const result = await callback({ workDir, userData, debug, debugPath });
    return result;
  } catch (error) {
    keep = true;
    throw error;
  } finally {
    if (!keep) {
      await rm(workDir, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 250,
      }).catch((error) => console.warn(`e2e leftover ${workDir}: ${error}`));
    } else {
      console.error(`e2e logs kept at ${debugPath}`);
    }
  }
}
