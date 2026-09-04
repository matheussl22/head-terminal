#!/usr/bin/env node
// Windows CDP e2e for the zero-sized-pane fit guard (see `fitTerminal`).
//
// Headless on purpose: HEAD_TERMINAL_NO_FOCUS=1 creates the window and never
// shows it, so a run never steals focus, the mouse or the screen, and
// HEAD_TERMINAL_USER_DATA points at a throwaway profile so a run can't touch
// the sessions of an app already open on this machine.
//
// The regression: a pane that measures zero (minimized window, layout not
// settled yet) makes @xterm/addon-fit propose its 2x1 floor. `fit()` applies
// it, the buffer is truncated to two columns, and a ConPTY pane never reflows
// it back — the scrollback comes back as one or two characters per row.
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import {
  click,
  clickByText,
  connectRenderer,
  dispatchKey,
  dumpFailure,
  evaluate,
  fail,
  poll,
  setInputValue,
  spawnDev,
  stopApp,
  withWorkDir,
} from "./e2e-win-harness.mjs";

// The window is created but never shown: no focus, no mouse, no screen.
process.env.HEAD_TERMINAL_NO_FOCUS = "1";

const ITERATIONS = Number(
  process.argv.find((arg) => arg.startsWith("--iterations="))
    ?.slice("--iterations=".length) ?? 5,
);

/** Reaches the pane's TerminalInstance ({ terminal, fitAddon }) through React. */
const INSTANCE = `
  const paneInstance = (() => {
    const pane = document.querySelector(
      ".session-workspace--visible .terminal-pane",
    );
    if (!pane) return null;
    const key = Object.keys(pane).find((name) => name.startsWith("__reactFiber$"));
    let fiber = key ? pane[key] : null;
    while (fiber) {
      let hook = fiber.memoizedState;
      while (hook) {
        const state = hook.memoizedState;
        if (state && typeof state === "object" && state.terminal && state.fitAddon) {
          return state;
        }
        hook = hook.next;
      }
      fiber = fiber.return;
    }
    return null;
  })();
`;

const READ_LINE = `
  const readLine = (needle) => {
    const buffer = paneInstance.terminal.buffer.active;
    for (let y = 0; y < buffer.length; y += 1) {
      const line = buffer.getLine(y)?.translateToString(true) ?? "";
      if (line.includes(needle)) return line;
    }
    return null;
  };
`;

/** ConPTY clears the screen while a shell boots; nothing is stable until then. */
async function waitForQuietBuffer(cdp, debug, quietMs = 2_000, timeout = 60_000) {
  const sample = `(() => {
    ${INSTANCE}
    if (!paneInstance) return null;
    const buffer = paneInstance.terminal.buffer.active;
    let text = "";
    for (let y = 0; y < buffer.length; y += 1) {
      text += (buffer.getLine(y)?.translateToString(true) ?? "") + "\\n";
    }
    return buffer.length + "|" + text.length + "|" + text.trim().slice(-120);
  })()`;
  const deadline = Date.now() + timeout;
  let last = null;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const now = await evaluate(cdp, sample);
    if (now !== null && now === last) {
      if (Date.now() - stableSince >= quietMs) {
        debug(`pty quiet: ${JSON.stringify(now).slice(0, 120)}`);
        return;
      }
    } else {
      last = now;
      stableSince = Date.now();
    }
    await delay(300);
  }
  fail("pty output never settled");
}

async function diagCounts(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const diag = localStorage.getItem("head-terminal.diag.v2") || "";
      const lines = diag.split("\\n");
      return {
        skipped: lines.filter((line) => line.includes("terminal.fit_skipped")).length,
        resized: lines.filter((line) => line.includes("terminal.resized")).length,
        degenerate: lines
          .filter((line) => line.includes("terminal.resized"))
          .map((line) => { try { return JSON.parse(line); } catch { return null; } })
          .filter((entry) => entry && entry.meta && entry.meta.cols < 10)
          .length,
      };
    })()`,
  );
}

/** Ctrl+0 (reset font size) runs the app's own fitPanes over the target panes. */
async function forceFit(cdp) {
  await dispatchKey(cdp, "0", { ctrl: true, code: "Digit0" });
  await delay(400);
}

const ZERO_STYLE_ID = "e2e-fit-guard-zero";
// Enough scrollback that a 2-column reflow blows past xterm's 5000-line cap.
const FILLER_LINES = 400;

async function zeroPane(cdp) {
  // Same shape as a minimized window: the pane's box measures zero while the
  // React tree, the terminal and the pty all stay exactly where they were.
  await evaluate(
    cdp,
    `(() => {
      const style = document.createElement("style");
      style.id = ${JSON.stringify(ZERO_STYLE_ID)};
      // flex:1 on .app-shell__main would grow past a plain width:0.
      style.textContent = ".app-shell__main {"
        + " flex: 0 0 0 !important;"
        + " width: 0 !important; height: 0 !important;"
        + " min-width: 0 !important; min-height: 0 !important; }";
      document.head.append(style);
      return true;
    })()`,
  );
  await delay(400);
  await forceFit(cdp);
}

async function restorePane(cdp) {
  await evaluate(
    cdp,
    `(() => {
      document.getElementById(${JSON.stringify(ZERO_STYLE_ID)})?.remove();
      return true;
    })()`,
  );
  await delay(400);
  await forceFit(cdp);
  await delay(300);
}

async function paneState(cdp) {
  return evaluate(
    cdp,
    `(() => {
      ${INSTANCE}
      if (!paneInstance) return { error: "no pane instance" };
      return {
        cols: paneInstance.terminal.cols,
        rows: paneInstance.terminal.rows,
        proposed: paneInstance.fitAddon.proposeDimensions() ?? null,
        windowsPty: paneInstance.terminal.options.windowsPty ?? null,
        scrollback: paneInstance.terminal.options.scrollback,
      };
    })()`,
  );
}

async function writeMarker(cdp, tag) {
  const written = await evaluate(
    cdp,
    `(() => {
      ${INSTANCE}
      if (!paneInstance) return { error: "no pane instance" };
      const cols = paneInstance.terminal.cols;
      const body = "X".repeat(Math.max(10, cols - 30));
      const marker = ${JSON.stringify(tag)} + "_" + body + "_END";
      paneInstance.terminal.__e2eTag = ${JSON.stringify(tag)};
      const filler = [];
      for (let i = 0; i < ${FILLER_LINES}; i += 1) {
        filler.push(
          String(i).padStart(4, "0") + " " + "y".repeat(Math.max(10, cols - 12)),
        );
      }
      paneInstance.terminal.write(
        "\\r\\n" + marker + "\\r\\n" + filler.join("\\r\\n") + "\\r\\n",
      );
      return { marker, cols, rows: paneInstance.terminal.rows };
    })()`,
  );
  if (written.error) fail(written.error);
  await poll(
    cdp,
    `(() => {
      ${INSTANCE}
      if (!paneInstance) return false;
      ${READ_LINE}
      return readLine(${JSON.stringify(written.marker)}) !== null;
    })()`,
    { timeout: 10_000 },
  );
  return written;
}

async function findMarker(cdp, marker, tag) {
  return evaluate(
    cdp,
    `(() => {
      ${INSTANCE}
      if (!paneInstance) return { error: "no pane instance" };
      ${READ_LINE}
      const buffer = paneInstance.terminal.buffer.active;
      const tail = [];
      for (let y = Math.max(0, buffer.length - 40); y < buffer.length; y += 1) {
        const line = buffer.getLine(y)?.translateToString(true) ?? "";
        if (line.trim()) tail.push(y + ":" + line.slice(0, 40));
      }
      return {
        intact: readLine(${JSON.stringify(marker)}),
        remains: readLine(${JSON.stringify(tag)}),
        cols: paneInstance.terminal.cols,
        rows: paneInstance.terminal.rows,
        sameTerminal: paneInstance.terminal.__e2eTag === ${JSON.stringify(tag)},
        bufferType: buffer.type,
        bufferLength: buffer.length,
        baseY: buffer.baseY,
        tail: tail.slice(-12),
      };
    })()`,
  );
}

async function createShellSession(cdp, debug) {
  const before = await evaluate(cdp, `document.querySelectorAll("[data-session-id]").length`);
  await click(cdp, ".session-sidebar__new");
  await poll(cdp, `Boolean(document.querySelector(".create-session-dialog"))`, {
    timeout: 15_000,
  });
  await poll(
    cdp,
    `![...document.querySelectorAll(".create-session-dialog__agent small")]
      .some((el) => (el.textContent || "").includes("Instalando"))`,
    { timeout: 60_000 },
  );
  await clickByText(cdp, ".create-session-dialog__agent", "Shell");
  await delay(200);
  // A native folder: panes on Windows no longer live inside WSL.
  await setInputValue(cdp, ".create-session-dialog__cwd-row input", tmpdir());
  await delay(100);
  await click(cdp, ".create-session-dialog__create");
  await poll(cdp, `!document.querySelector(".create-session-dialog")`, {
    timeout: 30_000,
  });
  await poll(cdp, `document.querySelectorAll("[data-session-id]").length`, {
    timeout: 20_000,
    predicate: (count) => count === before + 1,
  });
  await poll(
    cdp,
    `Boolean(document.querySelector(".session-workspace--visible .terminal-pane"))`,
    { timeout: 20_000 },
  );
  await delay(1_500);
  debug(`shell session ready (sessions=${before + 1})`);
}

/** The guarded path: the app's own ResizeObserver -> fitPane -> fitTerminal. */
async function guardedCycle(cdp, debug, index) {
  const tag = `FITGUARD${index}`;
  await waitForQuietBuffer(cdp, debug);
  const { marker, cols, rows } = await writeMarker(cdp, tag);

  const before = await diagCounts(cdp);
  await zeroPane(cdp);
  const zeroed = await paneState(cdp);
  await restorePane(cdp);
  const counts = await diagCounts(cdp);

  const after = await findMarker(cdp, marker, tag);
  if (after.error) fail(after.error);

  // The pane really did measure zero, so the addon really did offer its 2x1
  // floor — otherwise the run proves nothing.
  if (!zeroed.proposed || zeroed.proposed.cols > 2) {
    fail(
      `zero-size condition not reproduced: proposeDimensions=${JSON.stringify(zeroed.proposed)}`,
    );
  }
  if (counts.skipped <= before.skipped) {
    fail(
      `fitPane never ran while the pane measured zero (fit_skipped ${before.skipped} -> ${counts.skipped}); the guard was not exercised`,
    );
  }
  if (counts.degenerate > 0) {
    fail(`a degenerate size reached the pty: ${JSON.stringify(counts)}`);
  }
  if (zeroed.cols !== cols || zeroed.rows !== rows) {
    fail(
      `terminal was resized while the pane measured zero: ${cols}x${rows} -> ${zeroed.cols}x${zeroed.rows}`,
    );
  }
  if (!after.intact) {
    fail(
      `marker lost after the zero-size cycle: ${JSON.stringify(after, null, 2)}`,
    );
  }
  if (after.cols !== cols || after.rows !== rows) {
    fail(`size drifted: ${cols}x${rows} -> ${after.cols}x${after.rows}`);
  }
  debug(
    `iteration ${index}: ok (cols=${cols} rows=${rows}, proposed while zeroed=${JSON.stringify(zeroed.proposed)}, fit_skipped +${counts.skipped - before.skipped})`,
  );
  return {
    index,
    cols,
    rows,
    proposedWhileZeroed: zeroed.proposed,
    fitSkipped: counts.skipped - before.skipped,
  };
}

/**
 * Negative control: the old code path, `fitAddon.fit()` on a zero-sized pane.
 * It must destroy the buffer — a run where this passes silently would mean the
 * assertions above can't see the bug they're guarding against.
 */
async function legacyControl(cdp, debug) {
  const tag = "FITLEGACY";
  await waitForQuietBuffer(cdp, debug);
  const { marker, cols } = await writeMarker(cdp, tag);

  await zeroPane(cdp);
  const applied = await evaluate(
    cdp,
    `(() => {
      ${INSTANCE}
      if (!paneInstance) return { error: "no pane instance" };
      paneInstance.fitAddon.fit();
      return { cols: paneInstance.terminal.cols, rows: paneInstance.terminal.rows };
    })()`,
  );
  await restorePane(cdp);
  await evaluate(
    cdp,
    `(() => {
      ${INSTANCE}
      paneInstance?.fitAddon.fit();
      return true;
    })()`,
  );
  await delay(300);

  const after = await findMarker(cdp, marker, tag);
  debug(
    `legacy control: fit() applied ${JSON.stringify(applied)}, marker intact=${Boolean(after.intact)} remains=${JSON.stringify(after.remains)}`,
  );
  if (applied.cols !== 2) {
    fail(`legacy control never hit the 2-column floor: ${JSON.stringify(applied)}`);
  }
  if (after.intact) {
    fail("legacy control kept the marker — the assertions cannot see this bug");
  }
  return { truncatedFrom: cols, remains: after.remains };
}

async function main() {
  await withWorkDir(async ({ userData, debug, workDir }) => {
    const logPath = `${workDir}/electron.log`;
    const { child, log, state } = spawnDev({ userData, logPath });
    let cdp = null;
    try {
      cdp = await connectRenderer({ child, state, debug });
      await createShellSession(cdp, debug);

      const initial = await paneState(cdp);
      if (initial.error) fail(initial.error);
      debug(`initial pane ${JSON.stringify(initial)}`);
      if (!initial.cols || initial.cols < 10) {
        fail(`headless window never laid the pane out: ${JSON.stringify(initial)}`);
      }

      const runs = [];
      for (let index = 1; index <= ITERATIONS; index += 1) {
        runs.push(await guardedCycle(cdp, debug, index));
      }

      const control = await legacyControl(cdp, debug);

      const diag = await evaluate(
        cdp,
        `localStorage.getItem("head-terminal.diag.v2") || ""`,
      );
      const badResize = String(diag)
        .split("\n")
        .filter((line) => line.includes("terminal.resized"))
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((entry) => entry && entry.meta && entry.meta.cols < 10);
      if (badResize.length > 0) {
        fail(`pty was told a degenerate size: ${JSON.stringify(badResize)}`);
      }
      const skips = String(diag).split("\n").filter((line) =>
        line.includes("terminal.fit_skipped"),
      ).length;

      console.log(
        JSON.stringify(
          { ok: true, iterations: runs.length, runs, control, fitSkippedLogs: skips },
          null,
          2,
        ),
      );
    } catch (error) {
      if (cdp) {
        try {
          const diag = await evaluate(
            cdp,
            `localStorage.getItem("head-terminal.diag.v2") || ""`,
          );
          debug(`diag tail:\n${String(diag).trim().split("\n").slice(-45).join("\n")}`);
        } catch (dumpError) {
          debug(`diag dump failed ${dumpError}`);
        }
      }
      await dumpFailure({ debug, logPath, cdp });
      throw error;
    } finally {
      await stopApp({ cdp, child, state });
      log.end();
    }
  });
}

await main();
