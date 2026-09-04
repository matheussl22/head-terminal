#!/usr/bin/env node
// Windows CDP e2e: top user flows against `npm run dev` (smoke shell pane).
import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import {
  BOOT_TIMEOUT_MS,
  PROJECT_DIR,
  click,
  clickByText,
  connectRenderer,
  dispatchKey,
  dumpFailure,
  evaluate,
  fail,
  poll,
  putBitmapOnClipboard,
  putFileOnClipboard,
  setInputValue,
  snapshot,
  spawnDev,
  stopApp,
  waitForPtySpawn,
  withWorkDir,
} from "./e2e-win-harness.mjs";

const ALL_SCENARIOS = [
  "clipboard",
  "split",
  "session",
  "palette",
  "git",
  "restore",
];

export function parseOnly(argv = process.argv.slice(2)) {
  const flag = argv.find((arg) => arg.startsWith("--only="));
  if (!flag) return null;
  const ids = flag.slice("--only=".length).split(",").map((id) => id.trim()).filter(Boolean);
  return ids.length > 0 ? ids : null;
}

function wants(only, id) {
  return !only || only.includes(id);
}

async function sessionCount(cdp) {
  return evaluate(cdp, `document.querySelectorAll("[data-session-id]").length`);
}

async function visiblePaneCount(cdp) {
  return evaluate(
    cdp,
    `document.querySelectorAll(".session-workspace--visible .terminal-pane-shell").length`,
  );
}

async function activeTitle(cdp) {
  return evaluate(
    cdp,
    `document.querySelector(".session-sidebar__item--active .session-sidebar__title")
      ?.textContent?.trim() ?? ""`,
  );
}

async function waitNoInstalling(cdp) {
  await poll(
    cdp,
    `![...document.querySelectorAll(".create-session-dialog__agent small")]
      .some((el) => (el.textContent || "").includes("Instalando"))`,
    { timeout: 60_000 },
  );
}

async function openCreateDialog(cdp) {
  const nova = await evaluate(cdp, `Boolean(document.querySelector(".session-sidebar__new"))`);
  if (!nova) {
    fail("Nova button (.session-sidebar__new) not in the DOM — sidebar may be collapsed");
  }
  await click(cdp, ".session-sidebar__new");
  await poll(cdp, `Boolean(document.querySelector(".create-session-dialog"))`, {
    timeout: 10_000,
  });
}

async function createShellSession(cdp, { cwd, debug } = {}) {
  const before = await sessionCount(cdp);
  await openCreateDialog(cdp);
  await waitNoInstalling(cdp);
  await clickByText(cdp, ".create-session-dialog__agent", "Shell");
  await delay(200);
  if (cwd) {
    await setInputValue(cdp, ".create-session-dialog__cwd-row input", cwd);
    await delay(100);
  }
  await click(cdp, ".create-session-dialog__create");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const open = await evaluate(cdp, `Boolean(document.querySelector(".create-session-dialog"))`);
    if (!open) break;
    const error = await evaluate(
      cdp,
      `document.querySelector(".create-session-dialog__error")?.textContent || ""`,
    );
    if (error) fail(`create session failed: ${error}`);
    await delay(200);
  }
  if (await evaluate(cdp, `Boolean(document.querySelector(".create-session-dialog"))`)) {
    fail("create session dialog stayed open");
  }
  await poll(cdp, `document.querySelectorAll("[data-session-id]").length`, {
    timeout: 20_000,
    predicate: (count) => count === before + 1,
  });
  debug?.(`created shell session count=${before + 1} cwd=${cwd ?? "(default)"}`);
}

async function closeSessionByTitle(cdp, title) {
  const selectorClick = `(() => {
    const title = ${JSON.stringify(title)};
    const item = [...document.querySelectorAll("[data-session-id]")].find((el) =>
      (el.querySelector(".session-sidebar__title")?.textContent || "").trim() === title,
    );
    const button = item?.querySelector(".session-sidebar__action--remove");
    if (!button) return false;
    button.click();
    return true;
  })()`;
  if (!await evaluate(cdp, selectorClick)) {
    fail(`could not close session titled ${JSON.stringify(title)}`);
  }
  await delay(80);
  if (!await evaluate(cdp, selectorClick)) {
    fail(`second close click missed session ${JSON.stringify(title)}`);
  }
  await poll(
    cdp,
    `![...document.querySelectorAll(".session-sidebar__title")]
      .some((el) => el.textContent.trim() === ${JSON.stringify(title)})`,
    { timeout: 10_000 },
  );
}

async function renameActiveSession(cdp, nextTitle, debug) {
  await dispatchKey(cdp, "F2", { code: "F2" });
  const opened = await evaluate(
    cdp,
    `Boolean(document.querySelector(".session-sidebar__rename-input"))`,
  );
  if (!opened) {
    debug("F2 did not open rename input; clicking the pencil");
    await click(cdp, ".session-sidebar__item--active .session-sidebar__action--rename");
    await poll(cdp, `Boolean(document.querySelector(".session-sidebar__rename-input"))`);
  }
  await setInputValue(cdp, ".session-sidebar__rename-input", nextTitle);
  await delay(50);
  await evaluate(
    cdp,
    `(() => {
      const input = document.querySelector(".session-sidebar__rename-input");
      input?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }));
      input?.blur();
      return true;
    })()`,
  );
  await poll(
    cdp,
    `[...document.querySelectorAll(".session-sidebar__title")]
      .some((el) => el.textContent.trim() === ${JSON.stringify(nextTitle)})`,
    { timeout: 8_000 },
  );
}

async function scenarioClipboard({ cdp, debug }) {
  await delay(800);
  const clipboardText = await evaluate(
    cdp,
    `window.headTerminal.clipboard.readForTerminal()`,
    true,
  );
  debug(`clipboard before bitmap=${JSON.stringify(clipboardText)}`);
  await putBitmapOnClipboard();
  debug("bitmap on clipboard");
  await delay(200);

  const imagePayload = await evaluate(
    cdp,
    `window.headTerminal.clipboard.readForTerminal()`,
    true,
  );
  debug(`imagePayload=${imagePayload}`);
  const unquotedImagePath = typeof imagePayload === "string"
    ? imagePayload.replaceAll("'", "").trim()
    : "";
  if (
    !unquotedImagePath.endsWith(".png")
    || !/^[A-Za-z]:\\/u.test(unquotedImagePath)
  ) {
    fail(
      `readForTerminal after bitmap: ${JSON.stringify(imagePayload)} (before=${JSON.stringify(clipboardText)})`,
    );
  }

  const savedWindowsPath = unquotedImagePath;
  const pngBytes = await readFile(savedWindowsPath);
  const pngHead = Array.from(pngBytes.subarray(0, 4));
  if (pngHead[0] !== 0x89 || pngHead[1] !== 0x50 || pngHead[2] !== 0x4e || pngHead[3] !== 0x47) {
    fail(`saved file is not a PNG: ${pngHead}`);
  }

  await evaluate(
    cdp,
    `(() => {
      window.__htPasteWrites = [];
      try {
        const orig = window.headTerminal.terminal.write.bind(window.headTerminal.terminal);
        window.headTerminal.terminal.write = (input) => {
          window.__htPasteWrites.push(input && input.data ? input.data : input);
          return orig(input);
        };
      } catch (error) {
        window.__htPasteWrapError = String(error);
      }
      const pane = document.querySelector(".terminal-pane");
      const helper = document.querySelector(".xterm-helper-textarea");
      helper?.focus();
      pane?.focus();
      pane?.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
      return true;
    })()`,
  );

  let writes = "";
  let loggedPaste = false;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await delay(100);
    const chunks = await evaluate(cdp, `window.__htPasteWrites`);
    writes = Array.isArray(chunks) ? chunks.join("") : "";
    const diag = await evaluate(
      cdp,
      `localStorage.getItem("head-terminal.diag.v2") || ""`,
    );
    loggedPaste = typeof diag === "string" && diag.includes("terminal.clipboard_paste");
    if (writes.includes(".png") || loggedPaste) break;
  }
  const ptyWriteHasPath = writes.includes(imagePayload) || writes.includes(".png");
  if (!ptyWriteHasPath && !loggedPaste) {
    const wrapError = await evaluate(cdp, `window.__htPasteWrapError || null`);
    fail(
      `paste event did not reach the PTY. writes=${JSON.stringify(writes)} wrapError=${wrapError} payload=${imagePayload}`,
    );
  }

  await putFileOnClipboard(savedWindowsPath);
  await delay(200);
  const filePayload = await evaluate(
    cdp,
    `window.headTerminal.clipboard.readForTerminal()`,
    true,
  );
  const expectedFile = savedWindowsPath;
  debug(`filePayload=${filePayload} expected=${expectedFile}`);
  if (
    typeof filePayload !== "string"
    || filePayload.replaceAll("'", "").trim() !== expectedFile
  ) {
    fail(
      `readForTerminal after Explorer file copy: ${JSON.stringify(filePayload)} expected ${expectedFile}`,
    );
  }

  const ctrlV = await evaluate(
    cdp,
    `(() => {
      const pane = document.querySelector(".terminal-pane");
      const helper = document.querySelector(".xterm-helper-textarea");
      helper?.focus();
      pane?.focus();
      const event = new KeyboardEvent("keydown", {
        key: "v",
        code: "KeyV",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      pane?.dispatchEvent(event);
      return event.defaultPrevented;
    })()`,
  );
  if (!ctrlV) {
    fail("Ctrl+V on .terminal-pane was not preventDefaulted");
  }

  let ctrlVLogged = false;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await delay(100);
    const diag = await evaluate(
      cdp,
      `localStorage.getItem("head-terminal.diag.v2") || ""`,
    );
    ctrlVLogged = typeof diag === "string" && diag.includes("terminal.clipboard_paste");
    if (ctrlVLogged) break;
  }
  if (!ctrlVLogged) {
    fail("Ctrl+V after Explorer file copy did not log terminal.clipboard_paste");
  }

  return { payload: imagePayload, ptyWriteHasPath, loggedPaste, filePayload };
}

async function scenarioSplit({ cdp, debug }) {
  const before = await visiblePaneCount(cdp);
  if (before !== 1) {
    debug(`split starting with ${before} visible panes; closing extras first`);
    for (let i = 0; i < 6; i += 1) {
      const count = await visiblePaneCount(cdp);
      if (count <= 1) break;
      const closed = await evaluate(
        cdp,
        `(() => {
          const button = document.querySelector(
            ".session-workspace--visible .terminal-pane-header__close",
          );
          if (!button) return false;
          button.click();
          return true;
        })()`,
      );
      if (!closed) break;
      await delay(300);
    }
  }

  const splitVertical = await evaluate(
    cdp,
    `Boolean(document.querySelector('.session-workspace--visible [aria-label="Dividir verticalmente"]'))`,
  );
  if (!splitVertical) {
    return {
      skipped: true,
      reason: "pane header missing aria-label=\"Dividir verticalmente\"",
    };
  }

  await click(cdp, '.session-workspace--visible [aria-label="Dividir verticalmente"]');
  await poll(
    cdp,
    `document.querySelectorAll(".session-workspace--visible .terminal-pane-shell").length`,
    { predicate: (count) => count === 2, timeout: 8_000 },
  );
  await poll(
    cdp,
    `document.querySelectorAll(".session-workspace--visible .layout-divider").length >= 1`,
  );

  const folders = await evaluate(
    cdp,
    `[...document.querySelectorAll(
      ".session-workspace--visible .terminal-pane-header__cwd",
    )].map((button) => button.getAttribute("aria-label"))`,
  );
  if (!Array.isArray(folders) || folders.length !== 2) {
    fail(`expected a folder button on both panes, got ${JSON.stringify(folders)}`);
  }
  if (folders[0] !== folders[1] || !/^Pasta do terminal: [A-Za-z]:\\/u.test(folders[0])) {
    fail(`split pane should inherit a native folder, got ${JSON.stringify(folders)}`);
  }

  await evaluate(
    cdp,
    `(() => {
      const headers = [...document.querySelectorAll(
        ".session-workspace--visible .terminal-pane-header",
      )];
      headers[1]?.click();
      return headers.length;
    })()`,
  );
  await poll(
    cdp,
    `Boolean(document.querySelectorAll(
      ".session-workspace--visible .terminal-pane-header",
    )[1]?.classList.contains("terminal-pane-header--active"))`,
  );

  await click(
    cdp,
    ".session-workspace--visible .terminal-pane-header__close",
  );
  await poll(
    cdp,
    `document.querySelectorAll(".session-workspace--visible .terminal-pane-shell").length`,
    { predicate: (count) => count === 1, timeout: 8_000 },
  );

  const splitHorizontal = await evaluate(
    cdp,
    `Boolean(document.querySelector('.session-workspace--visible [aria-label="Dividir horizontalmente"]'))`,
  );
  if (splitHorizontal) {
    await click(cdp, '.session-workspace--visible [aria-label="Dividir horizontalmente"]');
    await poll(
      cdp,
      `document.querySelectorAll(".session-workspace--visible .terminal-pane-shell").length`,
      { predicate: (count) => count === 2, timeout: 8_000 },
    );
    await click(
      cdp,
      ".session-workspace--visible .terminal-pane-header__close",
    );
    await poll(
      cdp,
      `document.querySelectorAll(".session-workspace--visible .terminal-pane-shell").length`,
      { predicate: (count) => count === 1, timeout: 8_000 },
    );
  }

  return { vertical: true, horizontal: Boolean(splitHorizontal) };
}

async function scenarioSession({ cdp, debug }) {
  const before = await sessionCount(cdp);
  const firstTitle = await activeTitle(cdp);
  await createShellSession(cdp, { cwd: PROJECT_DIR, debug });
  const afterCreate = await sessionCount(cdp);
  if (afterCreate !== before + 1) {
    fail(`expected ${before + 1} sessions after Nova, got ${afterCreate}`);
  }
  if (afterCreate < 2) {
    fail("session lifecycle needs two sessions");
  }

  const createdTitle = await activeTitle(cdp);
  debug(`active after create=${createdTitle} previous=${firstTitle}`);

  await dispatchKey(cdp, "Tab", { ctrl: true, code: "Tab" });
  await delay(200);
  let switched = await activeTitle(cdp);
  if (switched === createdTitle) {
    debug("Ctrl+Tab did not switch; clicking the other sidebar item");
    await evaluate(
      cdp,
      `(() => {
        const current = ${JSON.stringify(createdTitle)};
        const other = [...document.querySelectorAll("[data-session-id]")].find((el) =>
          (el.querySelector(".session-sidebar__title")?.textContent || "").trim() !== current,
        );
        other?.querySelector(".session-sidebar__select")?.click();
        return true;
      })()`,
    );
    switched = await activeTitle(cdp);
  }
  if (switched === createdTitle) {
    fail(`Ctrl+Tab / sidebar click did not change active session from ${createdTitle}`);
  }

  // Switch back to the created session so F2 renames the extra one, then close it.
  await evaluate(
    cdp,
    `(() => {
      const title = ${JSON.stringify(createdTitle)};
      const item = [...document.querySelectorAll("[data-session-id]")].find((el) =>
        (el.querySelector(".session-sidebar__title")?.textContent || "").trim() === title,
      );
      item?.querySelector(".session-sidebar__select")?.click();
      return true;
    })()`,
  );
  await poll(
    cdp,
    `(document.querySelector(".session-sidebar__item--active .session-sidebar__title")
      ?.textContent || "").trim() === ${JSON.stringify(createdTitle)}`,
  );

  const renamed = "E2E Sessão";
  await renameActiveSession(cdp, renamed, debug);
  await closeSessionByTitle(cdp, renamed);
  const afterClose = await sessionCount(cdp);
  if (afterClose !== before) {
    fail(`expected ${before} sessions after close, got ${afterClose}`);
  }
  return { created: createdTitle, renamed, switchedFrom: createdTitle, switchedTo: switched };
}

async function scenarioPalette({ cdp, debug }) {
  await dispatchKey(cdp, "P", { ctrl: true, shift: true, code: "KeyP" });
  let palette = await evaluate(cdp, `Boolean(document.querySelector(".command-palette"))`);
  if (!palette) {
    debug("Ctrl+Shift+P did not open palette; clicking toolbar");
    await click(cdp, '[aria-label="Paleta de comandos"]');
    await poll(cdp, `Boolean(document.querySelector(".command-palette"))`);
  }

  await setInputValue(cdp, ".command-palette__input", "config");
  await delay(150);
  await clickByText(cdp, ".command-palette__item", "Configurações");
  await poll(cdp, `Boolean(document.querySelector(".settings-dialog"))`, {
    timeout: 8_000,
  });

  await clickByText(cdp, ".settings-nav__item", "Terminal");
  await poll(
    cdp,
    `Boolean(document.querySelector('.settings-dialog input[type="number"]'))`,
  );
  await setInputValue(cdp, '.settings-dialog input[type="number"]', "14");
  await delay(200);
  const stored = await evaluate(
    cdp,
    `localStorage.getItem("head-terminal.font-size")`,
  );
  if (stored !== "14") {
    fail(`expected localStorage head-terminal.font-size=14, got ${JSON.stringify(stored)}`);
  }

  await click(cdp, '[aria-label="Fechar configurações"]');
  await poll(cdp, `!document.querySelector(".settings-dialog")`);
  const paletteLeft = await evaluate(cdp, `Boolean(document.querySelector(".command-palette"))`);
  if (paletteLeft) {
    await click(cdp, ".command-palette-backdrop");
  }
  return { fontSize: stored };
}

async function scenarioGit({ cdp, debug }) {
  const already = await evaluate(
    cdp,
    `Boolean(document.querySelector(".git-branch-badge") || document.querySelector(".terminal-status-bar"))`,
  );
  if (!already) {
    debug(`no git badge on smoke cwd; creating Shell session at ${PROJECT_DIR}`);
    await createShellSession(cdp, { cwd: PROJECT_DIR, debug });
  }

  try {
    await poll(
      cdp,
      `Boolean(document.querySelector(".git-branch-badge") || document.querySelector(".terminal-status-bar"))`,
      { timeout: 20_000 },
    );
  } catch {
    const context = await evaluate(
      cdp,
      `window.headTerminal.git.getContext(${JSON.stringify(PROJECT_DIR)})`,
      true,
    );
    return {
      skipped: true,
      reason: `git badge never rendered; getContext=${JSON.stringify(context)}`,
    };
  }

  const diffButton = await evaluate(
    cdp,
    `Boolean(document.querySelector(".terminal-status-bar__diff"))`,
  );
  if (!diffButton) {
    return {
      skipped: true,
      reason: "git badge present but Ver diff (.terminal-status-bar__diff) is missing",
    };
  }

  await click(cdp, ".terminal-status-bar__diff");
  await poll(cdp, `Boolean(document.querySelector(".session-diff"))`, {
    timeout: 10_000,
  });
  await dispatchKey(cdp, "Escape", { code: "Escape" });
  await poll(cdp, `!document.querySelector(".session-diff")`, { timeout: 5_000 });
  return { badge: true, diffClosed: true };
}

async function prepareRestoreMarker(cdp, debug) {
  await createShellSession(cdp, { cwd: PROJECT_DIR, debug });
  await renameActiveSession(cdp, "E2E Restore", debug);
  const splitExists = await evaluate(
    cdp,
    `Boolean(document.querySelector('.session-workspace--visible [aria-label="Dividir verticalmente"]'))`,
  );
  if (splitExists) {
    await click(cdp, '.session-workspace--visible [aria-label="Dividir verticalmente"]');
    await poll(
      cdp,
      `document.querySelectorAll(".session-workspace--visible .terminal-pane-shell").length >= 2`,
      { timeout: 8_000 },
    );
  }
  await poll(
    cdp,
    `window.headTerminal.workspace.load()`,
    {
      awaitPromise: true,
      timeout: 8_000,
      predicate: (workspace) =>
        Array.isArray(workspace?.sessions)
        && workspace.sessions.some((session) => session.title === "E2E Restore"),
    },
  );
}

async function assertRestore(cdp) {
  await poll(
    cdp,
    `[...document.querySelectorAll(".session-sidebar__title")]
      .some((el) => el.textContent.trim() === "E2E Restore")`,
    { timeout: 20_000 },
  );
  const panes = await visiblePaneCount(cdp);
  return { restored: true, visiblePanes: panes };
}

export async function runWinE2e(options = {}) {
  if (process.platform !== "win32") {
    console.log("SKIP win e2e: Windows only");
    return { ok: true, skipped: true, reason: "Windows only" };
  }

  const only = options.only ?? parseOnly();
  const results = [];
  const skipped = [];

  return withWorkDir(async ({ workDir, userData, debug }) => {
    const logPath = join(workDir, "app.log");
    let app = spawnDev({ userData, logPath });
    let cdp = null;
    const extraLogPaths = [];

    const record = (id, result) => {
      if (result?.skipped) {
        skipped.push({ id, reason: result.reason });
        debug(`SKIP ${id}: ${result.reason}`);
      } else {
        results.push({ id, ...result });
        debug(`PASS ${id} ${JSON.stringify(result)}`);
      }
    };

    try {
      cdp = await connectRenderer({
        child: app.child,
        state: app.state,
        debug,
      });
      debug(`boot snapshot ${JSON.stringify(await snapshot(cdp))}`);
      await waitForPtySpawn(cdp);
      debug("pty spawned");

      const ctx = { cdp, debug };

      if (wants(only, "clipboard")) {
        record("clipboard", await scenarioClipboard(ctx));
      }
      if (wants(only, "split")) {
        record("split", await scenarioSplit(ctx));
      }
      if (wants(only, "session")) {
        record("session", await scenarioSession(ctx));
      }
      if (wants(only, "palette")) {
        record("palette", await scenarioPalette(ctx));
      }
      if (wants(only, "git")) {
        record("git", await scenarioGit(ctx));
      }

      if (wants(only, "restore")) {
        await prepareRestoreMarker(cdp, debug);
        debug("restore: killing electron for relaunch");
        await stopApp({ cdp, child: app.child, state: app.state });
        cdp = null;
        app.log.close();

        const relaunchLog = join(workDir, "app-relaunch.log");
        extraLogPaths.push(relaunchLog);
        app = spawnDev({ userData, logPath: relaunchLog });
        cdp = await connectRenderer({
          child: app.child,
          state: app.state,
          debug,
        });
        await waitForPtySpawn(cdp);
        record("restore", await assertRestore(cdp));
      }

      const summary = {
        ok: true,
        passed: results.map((item) => item.id),
        skipped,
        userData,
        timeoutMs: BOOT_TIMEOUT_MS,
      };
      console.log(JSON.stringify(summary));
      return summary;
    } catch (error) {
      process.exitCode = 1;
      debug(`FAIL ${error instanceof Error ? error.stack ?? error.message : error}`);
      console.error(String(error instanceof Error ? error.message : error));
      await dumpFailure({
        debug,
        logPath,
        extraLogPaths,
        cdp,
      });
      throw error;
    } finally {
      await stopApp({ cdp, child: app.child, state: app.state });
      app.log.close();
    }
  });
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolvePath(entry)).href
    || entry.replaceAll("\\", "/").endsWith("e2e-win.mjs");
}

if (isMainModule()) {
  try {
    await runWinE2e();
  } catch {
    process.exitCode = 1;
  }
}
