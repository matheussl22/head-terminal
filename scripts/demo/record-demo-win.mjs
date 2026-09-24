#!/usr/bin/env node
// Records the README demo of Head Terminal on Windows.
//
//   node --experimental-websocket scripts/demo/record-demo-win.mjs [--keep]
//
// It builds a throwaway world — demo repositories under HT_DEMO_HOME
// (default C:\code, also used as the app's home so nothing touches the real
// profiles), two fake Claude accounts, a seeded workspace and fake agent CLIs
// first on PATH — boots `npm run dev` hidden on a private userData with CDP,
// plays the storyboard below with an injected cursor and captions, and saves
// the screencast frames plus their timestamps. encode.mjs turns them into the
// MP4 and GIF.
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { killTree, waitForCdp } from "../e2e-win-harness.mjs";
import { OVERLAY_JS } from "./overlay.mjs";
import { ACCOUNTS, SCENARIOS } from "./scenarios.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(HERE, "..", "..");
const KEEP = process.argv.includes("--keep");
const DEMO_HOME = process.env.HT_DEMO_HOME ?? "C:\\code";
const WORK = process.env.HT_DEMO_WORK ?? join(tmpdir(), "head-terminal-demo");
const CDP_PORT = process.env.HT_DEMO_CDP ?? "9477";
const VIEW = { width: 1440, height: 900 };
const DSF = Number(process.env.HT_DEMO_DSF ?? 1);
const FRAME_FORMAT = process.env.HT_DEMO_FORMAT ?? "png";
const HOME_MARKER = ".head-terminal-demo-home";
// Everything on screen runs this many times slower while recording (CSS and
// WAAPI through the CDP animation rate, the fake agents through their env,
// the storyboard through wait()); encode.mjs speeds the video back up.
const SLOWMO = Math.max(1, Number(process.env.HT_DEMO_SLOWMO ?? 2));
const wait = (ms) => delay(ms * SLOWMO);

const CTL = join(WORK, "ctl");
const USER_DATA = join(WORK, "user-data");
const FAKEBIN = join(WORK, "fakebin");
const FRAMES = join(WORK, "frames");

const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);

// ── world ─────────────────────────────────────────────────────────────────
const REPOS = {
  "checkout-api": {
    branch: "feat/sqs-retry",
    files: {
      "package.json": '{\n  "name": "checkout-api",\n  "private": true,\n  "scripts": { "test": "vitest run" }\n}\n',
      "src/queue/consumer.ts": "export async function consume(batch, handler) {\n  for (const msg of batch) {\n    await handler(msg)\n  }\n}\n",
      "src/queue/retry.ts": "export async function withRetry(fn, { retries, baseDelayMs }) {\n  return fn()\n}\n",
      "src/queue/metrics.ts": "export const counters = new Map()\n",
      "src/webhooks/payments.ts": "export function paymentsWebhook(req) {\n  return verify(req)\n}\n",
      "src/routes/refunds.ts": "export async function refund(charge, body) {\n  await gateway.refund(charge.id)\n}\n",
      "src/routes/charges.ts": "export const charges = []\n",
      "src/ledger/export.ts": "export function exportLedger(charges) {\n  return charges.map(entry)\n}\n",
      "src/ledger/entry.ts": "export const entry = (c) => ({ id: c.id, amount: c.amount })\n",
      "openapi/payments.yaml": "openapi: 3.1.0\ninfo:\n  title: Payments\n",
      "README.md": "# checkout-api\n",
      ".gitignore": "node_modules/\n.env\n",
    },
  },
  "landing-page": {
    branch: "feat/hero-refresh",
    files: {
      "package.json": '{\n  "name": "landing-page",\n  "private": true\n}\n',
      "src/components/Hero.tsx": "export const Hero = () => <h1 className=\"text-blue-600 text-5xl\">Build faster</h1>\n",
      "src/components/CTA.tsx": "export const CTA = () => <button>Start</button>\n",
      "src/styles/tokens.css": ":root { --brand-500: #f0a832; }\n",
    },
  },
  "mobile-app": {
    branch: "feat/design-tokens",
    files: {
      "package.json": '{\n  "name": "mobile-app",\n  "private": true\n}\n',
      "src/screens/SettingsScreen.tsx": "export const styles = { color: '#1f6feb', padding: 12 }\n",
      "src/theme/tokens.ts": "export const tokens = {}\n",
    },
  },
  infra: {
    branch: "feat/payments-dlq",
    files: {
      "main.tf": 'module "queue" {\n  source = "./modules/queue"\n}\n',
      "modules/queue/main.tf": 'resource "aws_sqs_queue" "payments" {\n  name = "payments"\n}\n',
    },
  },
};

function git(cwd, ...args) {
  execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", "-c", "core.autocrlf=false", ...args], {
    cwd,
    stdio: "ignore",
    windowsHide: true,
  });
}

function prepareHome() {
  if (existsSync(DEMO_HOME) && !existsSync(join(DEMO_HOME, HOME_MARKER))) {
    throw new Error(`${DEMO_HOME} exists and is not a demo home; set HT_DEMO_HOME to an unused folder`);
  }
  rmSync(DEMO_HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  mkdirSync(DEMO_HOME, { recursive: true });
  writeFileSync(join(DEMO_HOME, HOME_MARKER), "Created by scripts/demo/record-demo-win.mjs; safe to delete.\n");
  for (const [name, repo] of Object.entries(REPOS)) {
    const dir = join(DEMO_HOME, name);
    for (const [file, content] of Object.entries(repo.files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    git(dir, "init", "-q", "-b", repo.branch);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Initial commit");
  }
}

function prepareWork() {
  rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  for (const dir of [CTL, join(CTL, "queue"), join(CTL, "ctl"), join(CTL, "state"), USER_DATA, FAKEBIN, FRAMES]) {
    mkdirSync(dir, { recursive: true });
  }
  const agent = join(HERE, "fake-agent.mjs");
  for (const name of ["claude", "codex", "cursor-agent", "agy", "ollama", "llama-cli"]) {
    writeFileSync(join(FAKEBIN, `${name}.cmd`), `@"${process.execPath}" "${agent}" ${name} %*\r\n`);
    writeFileSync(join(FAKEBIN, `${name}.ps1`), `& "${process.execPath}" "${agent}" ${name} @args\r\n`);
  }

  const cwd = (name) => join(DEMO_HOME, name);
  const pane = (paneId) => ({ kind: "pane", paneId });
  const workspace = {
    version: 1,
    activeSessionId: "s-api",
    activePaneId: "p-api-1",
    sessions: [
      {
        id: "s-api", title: "checkout-api", cwd: cwd("checkout-api"), agentProfileId: "claude",
        claudeAccountId: ACCOUNTS.work,
        layout: { kind: "split", direction: "horizontal", ratio: 0.5, first: pane("p-api-1"), second: pane("p-api-2") },
      },
      {
        id: "s-web", title: "landing-page", cwd: cwd("landing-page"), agentProfileId: "claude",
        claudeAccountId: ACCOUNTS.personal, layout: pane("p-web-1"),
      },
      { id: "s-mobile", title: "mobile-app", cwd: cwd("mobile-app"), agentProfileId: "codex", layout: pane("p-mobile-1") },
      { id: "s-infra", title: "infra", cwd: cwd("infra"), agentProfileId: "cursor", layout: pane("p-infra-1") },
    ],
    paneResumeSessionIds: {
      "p-api-1": SCENARIOS["api-retry"].resumeId,
      "p-api-2": SCENARIOS["api-tests"].resumeId,
      "p-web-1": SCENARIOS["web-hero"].resumeId,
      "p-mobile-1": SCENARIOS["mobile-tokens"].resumeId,
      "p-infra-1": SCENARIOS["infra-dlq"].resumeId,
    },
    conversationLabels: Object.fromEntries(
      ["api-retry", "api-tests", "web-hero", "mobile-tokens", "infra-dlq"].map((key) => [SCENARIOS[key].resumeId, SCENARIOS[key].title]),
    ),
  };
  writeFileSync(join(USER_DATA, "workspace.v1.dev.json"), JSON.stringify(workspace, null, 2));
  writeFileSync(join(USER_DATA, "workspace.v1.json"), JSON.stringify(workspace, null, 2));
  const preferences = {
    version: 1,
    values: {
      "head-terminal.claude-default-account-name": "Personal",
      "head-terminal.claude-accounts": JSON.stringify([{ id: ACCOUNTS.work, name: "Work", configDir: "x" }]),
      "head-terminal.last-agent": "claude",
      "head-terminal.last-claude-account": ACCOUNTS.work,
      "head-terminal.recent-cwds": JSON.stringify(["checkout-api", "landing-page", "mobile-app", "infra"].map(cwd)),
      "head-terminal.font-size": "14",
      "head-terminal.sidebar.collapsed": "0",
      "head-terminal.pane-headers.enabled": "1",
    },
  };
  writeFileSync(join(USER_DATA, "preferences.v1.json"), JSON.stringify(preferences, null, 2));
}

// ── app ───────────────────────────────────────────────────────────────────
function launchApp() {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = `${FAKEBIN};${env[pathKey]}`;
  Object.assign(env, {
    NODE_ENV: "development",
    HEAD_TERMINAL_SMOKE: "1",
    HEAD_TERMINAL_SKIP_CLI_INSTALL: "1",
    HEAD_TERMINAL_NO_FOCUS: "1",
    HEAD_TERMINAL_USER_DATA: USER_DATA,
    HEAD_TERMINAL_E2E_CDP: CDP_PORT,
    // Without this, every git status the app's repo watcher runs takes the
    // optional index.lock, which the watcher itself sees as a change: an
    // endless status loop that keeps the main process busy spawning git.
    GIT_OPTIONAL_LOCKS: "0",
    HT_DEMO_DIR: CTL,
    HT_DEMO_SLOWMO: String(SLOWMO),
    USERPROFILE: DEMO_HOME,
  });
  const flags = [
    "--disable-features=CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
  ];
  const logStream = createWriteStream(join(WORK, "dev.log"));
  const child = spawn("npm.cmd", ["run", "dev", "--", ...flags], {
    cwd: PROJECT_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: true,
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  return child;
}

function cdpClient(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed")));
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    for (const fn of listeners.get(message.method) ?? []) fn(message.params);
  });
  return {
    ready,
    send(method, params = {}) {
      const callId = ++id;
      ws.send(JSON.stringify({ id: callId, method, params }));
      return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
    },
    on(method, fn) {
      listeners.set(method, [...(listeners.get(method) ?? []), fn]);
    },
    close() {
      try {
        ws.close();
      } catch {
        // Already gone.
      }
    },
  };
}

let cdp;
async function js(expression) {
  const started = Date.now();
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  const took = Date.now() - started;
  if (took > 500) log(`slow evaluate ${took}ms: ${expression.replace(/\s+/g, " ").slice(0, 70)}`);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function until(expression, { timeout = 20_000, interval = 100, what = expression } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await js(expression);
    if (last) return last;
    await delay(interval);
  }
  throw new Error(`timed out waiting for ${what} (last=${JSON.stringify(last)})`);
}

// ── fake agent control ────────────────────────────────────────────────────
let queueSeq = 0;
function enqueue(scenario) {
  queueSeq += 1;
  writeFileSync(join(CTL, "queue", `${String(queueSeq).padStart(4, "0")}-${scenario}`), "");
}
function command(scenario, cmd) {
  writeFileSync(join(CTL, "ctl", scenario), `${cmd}\n`);
}
async function agentPhase(scenario, phases, timeout = 20_000) {
  const wanted = [].concat(phases);
  const file = join(CTL, "state", `${scenario}.json`);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(readFileSync(file, "utf8"));
      if (wanted.includes(state.phase)) return state;
    } catch {
      // Not written yet, or caught mid-write.
    }
    await delay(80);
  }
  throw new Error(`agent ${scenario} never reached ${wanted.join("/")}`);
}

// ── pointer ───────────────────────────────────────────────────────────────
let pointer = { x: 1500, y: 960 };
async function rect(selector) {
  const r = await js(`(() => {
    const el = ${selector.startsWith("(") ? selector : `document.querySelector(${JSON.stringify(selector)})`};
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  })()`);
  if (!r) throw new Error(`no element for ${selector}`);
  return r;
}
async function moveTo(target, ms) {
  const point = "x" in target && "w" in target
    ? { x: Math.round(target.x + target.w / 2), y: Math.round(target.y + target.h / 2) }
    : target;
  const distance = Math.hypot(point.x - pointer.x, point.y - pointer.y);
  const duration = ms ?? Math.round(Math.min(900, Math.max(380, 260 + distance * 0.55)));
  await js(`window.__demo.move(${point.x}, ${point.y}, ${duration})`);
  await wait(duration + 40);
  pointer = point;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  return point;
}
async function clickAt(target, { move, pause = 140 } = {}) {
  const point = await moveTo(target, move);
  await wait(pause);
  await js("window.__demo.press()");
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await wait(60);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}
async function click(selector, options) {
  await clickAt(await rect(selector), options);
}
const caption = (title, sub = "", kbd = "") =>
  js(`window.__demo.caption(${JSON.stringify(title)}, ${JSON.stringify(sub)}, ${JSON.stringify(kbd)})`);
const ring = (selector, pad = 5, radius = 9) =>
  js(`window.__demo.ring(${selector.startsWith("(") ? selector : JSON.stringify(selector)}, ${pad}, ${radius})`);
const unring = (id) => js(`window.__demo.unring(${id ?? "null"})`);

const VISIBLE = ".session-workspace--visible";
const paneIds = () => js(`[...document.querySelectorAll("${VISIBLE} [data-pane-shell]")]
  .filter((el) => !el.classList.contains("terminal-pane-shell--parked")).map((el) => el.dataset.paneShell)`);
const byText = (selector, text) =>
  `([...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => (el.textContent || "").includes(${JSON.stringify(text)})))`;

// ── recording ─────────────────────────────────────────────────────────────
const frames = [];
const writes = [];
let recording = false;
const beats = [];
const wall = () => Date.now() / 1000;
const beat = (name) => {
  beats.push({ name, wall: wall() });
  log(`beat ${name}`);
};

async function startRecording() {
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const received = wall();
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    if (!recording) return;
    const file = `f${String(frames.length).padStart(6, "0")}.${FRAME_FORMAT === "png" ? "png" : "jpg"}`;
    frames.push({ file, t: metadata.timestamp, received });
    writes.push(writeFile(join(FRAMES, file), Buffer.from(data, "base64")));
  });
  recording = true;
  await cdp.send("Page.startScreencast", {
    format: FRAME_FORMAT,
    quality: Number(process.env.HT_DEMO_QUALITY ?? 90),
    everyNthFrame: 1,
    maxWidth: VIEW.width * DSF,
    maxHeight: VIEW.height * DSF,
  });
}

async function stopRecording() {
  await cdp.send("Page.stopScreencast");
  recording = false;
  await Promise.all(writes);
  // Beats are stamped on the wall clock; move them onto the frames' clock.
  const offsets = frames.map((f) => f.t - f.received).sort((a, b) => a - b);
  const offset = offsets[Math.floor(offsets.length / 2)] ?? 0;
  const t0 = frames[0]?.t ?? 0;
  const mapped = beats.map((b) => ({ name: b.name, at: +(b.wall + offset - t0).toFixed(3) }));
  const span = frames.length > 1 ? frames.at(-1).t - t0 : 0;
  writeFileSync(join(FRAMES, "index.json"), JSON.stringify({ view: VIEW, dsf: DSF, slowmo: SLOWMO, frames, beats: mapped }, null, 1));
  let worst = 0;
  for (let i = 1; i < frames.length; i += 1) {
    const gap = frames[i].t - frames[i - 1].t;
    worst = Math.max(worst, gap);
    if (gap > 0.35) log(`  gap ${(gap * 1000).toFixed(0)}ms at ${(frames[i - 1].t - t0).toFixed(2)}s`);
  }
  log(`captured ${frames.length} frames over ${span.toFixed(2)}s (${(frames.length / span).toFixed(1)} fps, worst gap ${(worst * 1000).toFixed(0)}ms)`);
  for (const b of mapped) log(`  ${b.at.toFixed(2).padStart(6)}s ${b.name}`);
}

const zoom = async (scale, ox = 0, oy = 0, ms = 700) => {
  await js(`window.__demo.zoom(${scale}, ${ox}, ${oy}, ${ms})`);
  await wait(ms + 60);
};
// Stretches where the app is busy starting something get sped up by encode.mjs.
const fastForward = (on) => beat(on ? "ff-start" : "ff-end");
// "dock" sits just above the minimized cards while the camera is zoomed on them.
const CAPTION_POSITIONS = { top: "top: 64px; bottom: auto", dock: "bottom: 118px", bottom: "" };
const captionAt = (where) =>
  js(`document.querySelector(".demo-caption").style.cssText = ${JSON.stringify(CAPTION_POSITIONS[where] ?? "")}, true`);

// ── storyboard ────────────────────────────────────────────────────────────
const center = (r) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });

// Glide the cursor to a point while the camera moves, so it lands on its next
// target instead of hovering whatever ends up under it after the zoom.
async function zoomWithCursor(scale, ox, oy, ms, point) {
  await js(`window.__demo.move(${point.x}, ${point.y}, ${ms})`);
  await zoom(scale, ox, oy, ms);
  pointer = point;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
}

// The app names new sessions "Claude N"; give this one a repo-style name like
// the others. Done inside a fast-forward, through the app's own F2 rename.
async function renameActiveSession(name) {
  try {
    await js(`(() => {
      document.activeElement?.blur();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", code: "F2", bubbles: true, cancelable: true }));
      return true;
    })()`);
    await until(`Boolean(document.querySelector(".session-sidebar__rename-input"))`, { timeout: 3000, what: "rename input" });
    await js(`(() => {
      const el = document.querySelector(".session-sidebar__rename-input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(name)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
      return true;
    })()`);
  } catch (error) {
    log(`rename skipped: ${error.message}`);
  }
}

async function storyboard() {
  // Title card, already on screen in the first frame.
  beat("intro");
  await wait(1000);
  await js("window.__demo.card(false)");
  await wait(700);

  // 1. Accounts: zoom into the sidebar, where each session names its account.
  beat("accounts");
  await caption("Work and personal Claude accounts at once", "Each session signs in on its own");
  const mobileItem = await rect('li[data-session-id="s-mobile"] .session-sidebar__select');
  await zoom(1.85, 0, 60, 700);
  const r1 = await ring('li[data-session-id="s-api"] .session-sidebar__account-chip', 4, 999);
  await wait(180);
  const r2 = await ring('li[data-session-id="s-web"] .session-sidebar__account-chip', 4, 999);
  await wait(700);
  await click('li[data-session-id="s-web"] .session-sidebar__select');
  await wait(600);
  await unring(r1);
  await unring(r2);
  command("mobile-tokens", "fast");
  await zoomWithCursor(1, 0, 60, 650, center(mobileItem));
  command("api-retry", "slow");
  command("api-tests", "slow");

  // 1b. Not only Claude: a glimpse of a Codex session.
  beat("agents");
  await caption("Claude Code, Codex, Cursor Agent… mix and match");
  await click('li[data-session-id="s-mobile"] .session-sidebar__select', { move: 250, pause: 80 });
  await wait(1500);

  // 2. New session: folder, agent, account (and a worktree, the repo is taken).
  beat("new-session");
  await click(".session-sidebar__new", { move: 450 });
  await until(`Boolean(document.querySelector(".create-session-dialog"))`);
  await caption("New session: pick a folder, an agent and an account");
  command("web-hero", "slow");
  command("mobile-tokens", "slow");
  await wait(300);
  await click(`([...document.querySelectorAll(".create-session-dialog__chip")].find((el) => (el.title || "").endsWith("checkout-api")))`);
  // The dialog asks git about the folder; spawning git on Windows stalls the
  // main process for a moment, so this wait plays fast.
  fastForward(true);
  await until(`Boolean(document.querySelector(".create-session-dialog__worktree input:checked"))`, { what: "worktree checkbox" });
  await delay(900);
  fastForward(false);
  await caption("Repo already open in another session?", "It offers a separate git worktree, so agents never collide");
  const rw = await ring(".create-session-dialog__worktree", 4, 8);
  await wait(1300);
  await unring(rw);
  enqueue("wt-refunds");
  await click(byText(".create-session-dialog__profile", "Personal"));
  await wait(350);
  await click(".create-session-dialog__create", { pause: 120 });
  fastForward(true);
  await until(`!document.querySelector(".create-session-dialog") && document.querySelectorAll("[data-session-id]").length === 5`, { timeout: 30_000, what: "new session" });
  await renameActiveSession("refunds");
  await agentPhase("wt-refunds", "typing", 30_000);
  fastForward(false);
  await agentPhase("wt-refunds", "working");
  await wait(400);

  // 3. Splits.
  beat("split");
  await caption("Split into as many agents as you need", "Every pane runs its own agent");
  const [p1] = await paneIds();
  enqueue("wt-tests");
  await click(`${VISIBLE} [data-pane-shell="${p1}"] [aria-label="Dividir horizontalmente"]`, { pause: 260 });
  fastForward(true);
  await until(`document.querySelectorAll("${VISIBLE} [data-pane-shell]").length === 2`);
  await agentPhase("wt-tests", "typing");
  fastForward(false);
  await wait(250);
  const p2 = (await paneIds()).find((id) => id !== p1);
  enqueue("wt-ledger");
  await click(`${VISIBLE} [data-pane-shell="${p2}"] [aria-label="Dividir verticalmente"]`, { pause: 260 });
  fastForward(true);
  await until(`document.querySelectorAll("${VISIBLE} [data-pane-shell]").length === 3`);
  await agentPhase("wt-ledger", "typing");
  fastForward(false);
  await agentPhase("wt-ledger", "working");
  await agentPhase("wt-tests", "working");
  await wait(1800);

  // 4. Minimize: the agents keep going, and the cards say when they need you.
  beat("minimize");
  await caption("Minimize a pane — its agent keeps running", "", "Ctrl+Shift+M");
  await wait(300);
  await click(`${VISIBLE} [aria-label="Minimizar cc2"]`, { pause: 200 });
  await until(`document.querySelectorAll(".minimized-card").length === 1`);
  await wait(500);
  await click(`${VISIBLE} [aria-label="Minimizar cc3"]`, { pause: 200 });
  await until(`document.querySelectorAll(".minimized-card").length === 2`);
  await wait(900);
  const cc3Card = await rect(`([...document.querySelectorAll(".minimized-card")].find((el) => /cc3/.test(el.getAttribute("aria-label") || "")))`);
  await caption(null);
  await moveTo({ x: 780, y: 640 }, 500);
  await captionAt("dock");
  await zoom(1.75, 560, 885, 700);

  // Approval first, then the other agent finishes: "done" needs 3 s of
  // silence to be detected, which gives the first caption time on screen.
  beat("approval");
  command("wt-ledger", "approve");
  await until(`Boolean(document.querySelector('.minimized-card--approval'))`, { what: "approval card" });
  await caption("The card lights up when an agent needs you…");
  await wait(900);
  command("wt-tests", "finish");
  await until(`Boolean(document.querySelector('.minimized-card--done'))`, { timeout: 15_000, what: "done card" });
  beat("done");
  await wait(200);
  await caption("…and when it is done");
  await wait(2000);
  await caption(null);
  await zoomWithCursor(1, 560, 885, 650, center(cc3Card));
  await captionAt("bottom");

  beat("restore");
  await caption("Click a card to bring its terminal back");
  await click(`([...document.querySelectorAll(".minimized-card")].find((el) => /cc3/.test(el.getAttribute("aria-label") || "")))`, { move: 250 });
  await wait(700);
  const restored = await rect(`(document.querySelector("${VISIBLE} .terminal-pane-shell--active"))`);
  const focus = { x: Math.round(restored.x + restored.w / 2), y: Math.round(restored.y + restored.h * 0.62) };
  await zoomWithCursor(1.45, focus.x, focus.y, 600, { x: Math.round(restored.x + restored.w * 0.85), y: Math.round(restored.y + restored.h * 0.9) });
  await caption("Answer right in the terminal", "", "1");
  await wait(1300);
  await cdp.send("Input.insertText", { text: "1" });
  await agentPhase("wt-ledger", "working", 5_000);
  await wait(1000);
  await caption(null);
  await zoomWithCursor(1, focus.x, focus.y, 600, { x: 1500, y: 960 });

  // Title card again, so the GIF loops seamlessly.
  beat("outro");
  await js("window.__demo.card(true)");
  await wait(1300);
  beat("end");
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  log(`demo home ${DEMO_HOME}, work ${WORK}`);
  prepareHome();
  prepareWork();
  const child = launchApp();
  try {
    const page = await waitForCdp(CDP_PORT, Date.now() + 180_000, () => {});
    cdp = cdpClient(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await until(`document.querySelectorAll("[data-session-id]").length === 4 && Boolean(document.querySelector(".xterm"))`, { timeout: 120_000, what: "seeded workspace" });
    log("workspace up");

    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    await cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEW, deviceScaleFactor: DSF, mobile: false });
    await js("Document.prototype.hasFocus = function () { return true }; true");
    await js(`window.__demoSlow = ${SLOWMO}; true`);
    await js(OVERLAY_JS);
    await js("window.__demo.card(true, true)");

    // Start every seeded agent so the sidebar is alive, then come back.
    for (const [session, scenarios] of [["s-web", ["web-hero"]], ["s-mobile", ["mobile-tokens"]], ["s-infra", ["infra-dlq"]], ["s-api", ["api-retry", "api-tests"]]]) {
      await js(`document.querySelector('li[data-session-id="${session}"] .session-sidebar__select').click(), true`);
      for (const scenario of scenarios) await agentPhase(scenario, "working", 40_000);
    }
    // The first dialog open probes every agent CLI with where.exe; do it now.
    await js(`document.querySelector(".session-sidebar__new").click(), true`);
    await until(`Boolean(document.querySelector(".create-session-dialog")) && ![...document.querySelectorAll(".create-session-dialog__agent small")].some((el) => /Instalando/.test(el.textContent || ""))`, { timeout: 60_000, what: "agent CLI probe" });
    await delay(400);
    await js(`document.querySelector(".create-session-dialog__close").click(), true`);
    await until(`!document.querySelector(".create-session-dialog")`);
    await delay(2500);
    log("agents warm");

    await cdp.send("Animation.enable");
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 / SLOWMO });
    await startRecording();
    await delay(300);
    await storyboard();
    await stopRecording();
    writeFileSync(join(WORK, "beats.json"), JSON.stringify(beats, null, 2));
  } finally {
    cdp?.close();
    if (child.pid) await killTree(child.pid);
    if (!KEEP) rmSync(DEMO_HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
  log(`frames in ${FRAMES}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
