#!/usr/bin/env node
// Fake agent CLI for the README demo recording. Head Terminal launches
// `claude`, `codex` or `cursor-agent` by name; the recorder puts shims for
// those names first on PATH so every pane runs this script instead. It draws
// a look-alike TUI, plays a scenario from scenarios.mjs and never exits (an
// exit would drop the pane to its shell fallback).
//
// Control is file based, under HT_DEMO_DIR:
//   queue/NNNN-<scenario>   claimed by the next pane started without --resume
//   ctl/<scenario>          "finish" or "approve", consumed by the agent
//   state/<scenario>.json   phase reported back to the recorder
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SCENARIOS, scenarioByResumeId } from "./scenarios.mjs";

const [, , toolName = "claude", ...args] = process.argv;
const DEMO_DIR = process.env.HT_DEMO_DIR;
// The recorder can run the whole world in slow motion (and speed the video
// back up), so a loaded machine still yields a frame for every change.
const SLOWMO = Math.max(1, Number(process.env.HT_DEMO_SLOWMO) || 1);

// Probes the app runs outside a pane (`ollama list`) or names that only need
// to exist for `where.exe`: answer and leave.
if (toolName === "ollama" && args[0] === "list") {
  process.stdout.write("NAME            ID              SIZE      MODIFIED\nqwen3:14b       bdbd181c33f2    9.3 GB    2 days ago\n");
  process.exit(0);
}
if (!process.stdout.isTTY || !DEMO_DIR || ["agy", "ollama", "llama-cli"].includes(toolName)) {
  if (process.stdout.isTTY) {
    process.stdout.write(`${toolName}: demo stub\r\n`);
    setInterval(() => {}, 1 << 30);
  } else {
    process.exit(0);
  }
}

// ── ANSI ──────────────────────────────────────────────────────────────────
const ESC = "\x1b[";
const rgb = (r, g, b) => `${ESC}38;2;${r};${g};${b}m`;
const bgRgb = (r, g, b) => `${ESC}48;2;${r};${g};${b}m`;
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const C = {
  claude: rgb(215, 119, 87),
  grey: rgb(153, 153, 153),
  dim: rgb(110, 110, 110),
  rule: rgb(78, 78, 78),
  white: rgb(230, 231, 234),
  text: rgb(214, 217, 222),
  green: rgb(78, 186, 101),
  red: rgb(255, 107, 107),
  blue: rgb(88, 166, 255),
  cyan: rgb(86, 212, 221),
  purple: rgb(175, 135, 255),
  codex: rgb(95, 209, 179),
  yellow: rgb(227, 179, 65),
  bgAdd: bgRgb(24, 64, 34),
  bgDel: bgRgb(84, 28, 32),
};
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visible = (s) => s.replace(ANSI_RE, "").length;
function fit(s, width) {
  // Truncate a styled string to `width` visible columns.
  let out = "";
  let seen = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const match = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    if (seen >= width) break;
    out += s[i];
    seen += 1;
    i += 1;
  }
  return out + RESET;
}
const pad = (s, width) => s + " ".repeat(Math.max(0, width - visible(s)));
function wrap(text, width) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

// ── scenario selection ────────────────────────────────────────────────────
function resumeIdFromArgs() {
  const flag = args.indexOf("--resume");
  if (flag >= 0) return args[flag + 1];
  if (args[0] === "resume") return args[1];
  return null;
}

function claimQueued() {
  const queue = join(DEMO_DIR, "queue");
  const claimed = join(DEMO_DIR, "claimed");
  mkdirSync(claimed, { recursive: true });
  let names = [];
  try {
    names = readdirSync(queue).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      renameSync(join(queue, name), join(claimed, `${name}.${process.pid}`));
      return name.replace(/^\d+-/, "");
    } catch {
      // Another pane took it first.
    }
  }
  return null;
}

const resumeId = resumeIdFromArgs();
const scenarioKey = scenarioByResumeId(resumeId) ?? claimQueued();
const scenario = SCENARIOS[scenarioKey] ?? {
  agent: toolName === "codex" ? "codex" : toolName === "cursor-agent" ? "cursor" : "claude",
  title: "",
  prompt: "",
  steps: [],
  loop: [],
  finish: [],
  idle: true,
};
const agent = scenario.agent;
const stateKey = scenarioKey ?? `unassigned-${process.pid}`;

function report(phase, extra = {}) {
  try {
    mkdirSync(join(DEMO_DIR, "state"), { recursive: true });
    writeFileSync(
      join(DEMO_DIR, "state", `${stateKey}.json`),
      JSON.stringify({ phase, pid: process.pid, cols, rows, at: Date.now(), ...extra }),
    );
  } catch {
    // Reporting is best effort.
  }
}

// A transcript file lets the app anchor the pane to a "conversation" and show
// its title in the pane header, exactly as it does for the real CLI.
function writeTranscript() {
  if (resumeId || !scenario.prompt) return;
  const uuid = randomUUID();
  const now = new Date().toISOString();
  try {
    if (agent === "claude" && process.env.CLAUDE_CONFIG_DIR) {
      const dir = join(
        process.env.CLAUDE_CONFIG_DIR,
        "projects",
        process.cwd().replace(/[^A-Za-z0-9]/g, "-"),
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${uuid}.jsonl`),
        `${JSON.stringify({ type: "user", uuid, timestamp: now, cwd: process.cwd(), message: { role: "user", content: scenario.prompt } })}\n`,
      );
    }
  } catch {
    // The header then just says "nova conversa".
  }
}

// ── screen model ──────────────────────────────────────────────────────────
// Transcript lines scroll up like any CLI output; the live region (spinner,
// input box) is repainted in place. Its position is tracked as an absolute
// screen row rather than with relative cursor moves, so a resize or a burst
// of scrolling can never leave stale copies behind. Only a resize repaints
// the whole screen: ConPTY forwards every cell that gets written, even when
// it did not change, so full-screen frames would flood the app.
let cols = process.stdout.columns || 80;
let rows = process.stdout.rows || 24;
const blocks = []; // committed content: functions (width) => lines
let liveFn = () => [];
let liveStart = 1;

const out = (s) => process.stdout.write(s);
const width = () => Math.max(20, cols - 1);
const contentWidth = () => Math.min(width(), 76);
const renderBlock = (fn) => fn(contentWidth()).map((line) => fit(line, width()));

// When idle the cursor sits in the input box, visible, like the real CLI.
let idleCursor = false;

let liveEnd = 0; // last screen row the live region occupied

function paint(appended) {
  const live = liveFn(width()).map((line) => fit(line, width()));
  const body = appended.concat(live);
  // Clear only what this frame overwrites or leaves behind: ConPTY forwards
  // every row a clear touches, and a flood of erased rows after an approval
  // prompt would push it out of the tail the app's detector reads.
  let text = `${ESC}?25l${ESC}${liveStart};1H${body.map((line) => `${line}${ESC}K`).join("\r\n")}`;
  const lastRow = liveStart + body.length - 1;
  for (let row = lastRow + 1; row <= Math.min(liveEnd, rows); row += 1) text += `\r\n${ESC}K`;
  const overflow = Math.max(0, lastRow - rows);
  liveStart = Math.max(1, liveStart + appended.length - overflow);
  liveEnd = Math.min(rows, lastRow - overflow);
  if (idleCursor) {
    const row = liveStart + live.length - 1 - look.inputLineFromBottom;
    text += `${ESC}${row};${visible(look.promptGlyph) + 1}H${ESC}?25h`;
  }
  out(text);
}

const drawLive = () => paint([]);

function commit(fn) {
  blocks.push(fn);
  paint(renderBlock(fn));
}

function redrawAll() {
  const liveHeight = liveFn(width()).length;
  const committed = blocks.flatMap(renderBlock);
  const room = Math.max(0, rows - liveHeight);
  liveStart = 1;
  liveEnd = 0;
  out(`${ESC}?25l${ESC}H${ESC}J`);
  paint(committed.slice(Math.max(0, committed.length - room)));
}

// ── agent looks ───────────────────────────────────────────────────────────
const LOOK = {
  claude: {
    banner(w) {
      const inner = Math.min(w, 56) - 2;
      const row = (s) => `${C.claude}│${RESET}${pad(` ${s}`, inner)}${C.claude}│${RESET}`;
      return [
        `${C.claude}╭${"─".repeat(inner)}╮${RESET}`,
        row(`${C.claude}✻${RESET} ${BOLD}${C.white}Welcome to Claude Code!${RESET}`),
        row(""),
        row(`  ${C.grey}/help for help, /status for your current setup${RESET}`),
        row(""),
        row(`  ${C.grey}cwd: ${process.cwd()}${RESET}`),
        `${C.claude}╰${"─".repeat(inner)}╯${RESET}`,
        "",
      ];
    },
    user(text, w) {
      return [...wrap(text, w - 2).map((l, i) => `${C.grey}${i ? "  " : "> "}${C.text}${l}${RESET}`), ""];
    },
    say(text, w, partial = false) {
      return [
        ...wrap(text, w - 2).map((l, i) => `${i ? "  " : `${C.white}●${RESET} `}${C.white}${l}${RESET}`),
        ...(partial ? [] : [""]),
      ];
    },
    tool(ev, w, state) {
      const bullet = state === "running" ? (blink() ? `${C.grey}●` : " ") : `${C.green}●`;
      const lines = [`${bullet}${RESET} ${BOLD}${C.white}${ev.tool}${RESET}${C.white}(${ev.arg})${RESET}`];
      if (state === "running") {
        if (ev.run) lines.push(`  ${C.grey}⎿  Running…${RESET}`);
        return lines;
      }
      const results = [].concat(ev.result ?? []);
      results.forEach((r, i) => lines.push(`  ${C.grey}${i ? "   " : "⎿  "}${r}${RESET}`));
      for (const [kind, n, text] of ev.diff ?? []) {
        const num = String(n).padStart(6);
        const mark = kind === "add" ? "+" : kind === "del" ? "-" : " ";
        const bg = kind === "add" ? C.bgAdd : kind === "del" ? C.bgDel : "";
        const body = `${num} ${mark} ${text}`;
        lines.push(`     ${bg}${C.text}${pad(body, Math.min(w, 70) - 6)}${RESET}`);
      }
      lines.push("");
      return lines;
    },
    todos(items) {
      return [
        `${C.green}●${RESET} ${BOLD}${C.white}Update Todos${RESET}`,
        ...items.map(([done, text], i) =>
          `  ${C.grey}${i ? "   " : "⎿  "}${done ? `${C.green}☒ ${ESC}9m${C.grey}${text}` : `${C.text}☐ ${text}`}${RESET}`),
        "",
      ];
    },
    spinner(verb, secs, tokens) {
      const glyph = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"][frame % 10];
      return `${C.claude}${glyph} ${verb}…${RESET} ${C.grey}(${secs}s · ↑ ${tokens} tokens · esc to interrupt)${RESET}`;
    },
    input(w, typed, ctx) {
      const hintLeft = `  ${C.grey}? for shortcuts${RESET}`;
      const hintRight = ctx ? `${C.grey}Context left until auto-compact: ${ctx}%${RESET}` : "";
      const gap = Math.max(2, w - visible(hintLeft) - visible(hintRight));
      return [
        `${C.rule}${"─".repeat(w)}${RESET}`,
        `${C.white}> ${RESET}${C.white}${typed}${RESET}`,
        `${C.rule}${"─".repeat(w)}${RESET}`,
        `${hintLeft}${" ".repeat(gap)}${hintRight}`,
      ];
    },
    promptGlyph: "> ",
    inputLineFromBottom: 2,
    approval(ap, w) {
      const file = ap.file.split("/").pop();
      return [
        `${C.blue}${"─".repeat(Math.min(w, 70))}${RESET}`,
        ` ${BOLD}${C.white}Edit file${RESET}`,
        ` ${C.grey}${ap.file}${RESET}`,
        ...ap.lines.map(([kind, n, text]) =>
          `   ${kind === "add" ? C.bgAdd : C.bgDel}${C.text}${pad(`${String(n).padStart(4)} + ${text}`, Math.min(w, 66) - 3)}${RESET}`),
        "",
        ` ${C.white}Do you want to make this edit to ${file}?${RESET}`,
        ` ${C.blue}❯ 1. Yes${RESET}`,
        `   2. Yes, allow all edits during this session`,
        `   3. No, and tell Claude what to do differently`,
      ];
    },
  },
  codex: {
    banner(w) {
      const inner = Math.min(w, 52) - 2;
      const row = (s) => `${C.dim}│${RESET}${pad(` ${s}`, inner)}${C.dim}│${RESET}`;
      return [
        `${C.dim}╭${"─".repeat(inner)}╮${RESET}`,
        row(`${C.white}>_ ${BOLD}OpenAI Codex${RESET} ${C.grey}(v0.47.0)${RESET}`),
        row(""),
        row(`${C.grey}model:     ${C.white}gpt-5-codex high${RESET}   ${C.cyan}/model${RESET}`),
        row(`${C.grey}directory: ${C.white}${process.cwd()}${RESET}`),
        `${C.dim}╰${"─".repeat(inner)}╯${RESET}`,
        "",
      ];
    },
    user(text, w) {
      return [...wrap(text, w - 2).map((l, i) => `${C.cyan}${i ? "  " : "› "}${RESET}${C.white}${l}${RESET}`), ""];
    },
    say(text, w, partial = false) {
      return [
        ...wrap(text, w - 2).map((l, i) => `${i ? "  " : `${C.white}• `}${C.text}${l}${RESET}`),
        ...(partial ? [] : [""]),
      ];
    },
    tool(ev, w, state) {
      const name = ev.run ? (state === "running" ? "Running" : "Ran") : ev.tool;
      const lines = [`${state === "running" && blink() ? C.grey : C.green}•${RESET} ${BOLD}${C.white}${name}${RESET} ${C.text}${ev.run ?? ev.arg}${RESET}`];
      if (state === "running") return lines;
      const results = [].concat(ev.result ?? []);
      results.forEach((r, i) => lines.push(`  ${C.grey}${i ? "  " : "└ "}${r}${RESET}`));
      for (const [kind, n, text] of ev.diff ?? []) {
        const color = kind === "add" ? C.green : kind === "del" ? C.red : C.grey;
        lines.push(`    ${color}${String(n).padStart(3)} ${kind === "add" ? "+" : kind === "del" ? "-" : " "}${text}${RESET}`);
      }
      lines.push("");
      return lines;
    },
    todos: () => [],
    spinner(verb, secs) {
      const shimmer = verb
        .split("")
        .map((ch, i) => (Math.abs(i - (frame % (verb.length + 6)) + 3) < 2 ? `${BOLD}${C.white}${ch}${RESET}` : `${C.grey}${ch}`))
        .join("");
      return `${frame % 8 < 4 ? C.white : C.grey}•${RESET} ${shimmer}${RESET} ${C.grey}(${secs}s • esc to interrupt)${RESET}`;
    },
    input(w, typed, ctx) {
      return [
        "",
        `${C.cyan}› ${RESET}${typed ? `${C.white}${typed}` : `${C.dim}Ask Codex to do anything`}${RESET}`,
        "",
        `  ${C.grey}${ctx ?? 100}% context left · ? for shortcuts${RESET}`,
      ];
    },
    promptGlyph: "› ",
    inputLineFromBottom: 2,
  },
  cursor: {
    banner() {
      return [
        ` ${BOLD}${C.white}Cursor Agent${RESET}`,
        ` ${C.grey}${process.cwd()} · feat/payments-dlq${RESET}`,
        "",
      ];
    },
    user(text, w) {
      return [...wrap(text, w - 3).map((l, i) => ` ${C.purple}${i ? "  " : "→ "}${RESET}${C.white}${l}${RESET}`), ""];
    },
    say(text, w, partial = false) {
      return [...wrap(text, w - 3).map((l) => ` ${C.text}${l}${RESET}`), ...(partial ? [] : [""])];
    },
    tool(ev, w, state) {
      const label = ev.run ? `$ ${ev.run}` : `${ev.tool} ${ev.arg}`;
      const lines = [` ${state === "running" ? C.grey : C.purple}⬢${RESET} ${C.white}${label}${RESET}`];
      if (state === "running") return lines;
      for (const r of [].concat(ev.result ?? [])) lines.push(`   ${C.grey}${r}${RESET}`);
      for (const [kind, n, text] of ev.diff ?? []) {
        lines.push(`   ${kind === "add" ? C.green : C.red}${String(n).padStart(3)} ${text}${RESET}`);
      }
      lines.push("");
      return lines;
    },
    todos: () => [],
    spinner(verb, secs) {
      const glyph = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame % 10];
      return ` ${C.purple}${glyph}${RESET} ${C.text}${verb}…${RESET}  ${C.grey}${secs}s${RESET}`;
    },
    input(w, typed) {
      const inner = Math.min(w, 60) - 3;
      return [
        ` ${C.dim}┌${"─".repeat(inner)}┐${RESET}`,
        ` ${C.dim}│${RESET}${pad(` ${C.purple}→ ${RESET}${typed ? `${C.white}${typed}` : `${C.dim}Add a follow-up`}${RESET}`, inner)}${C.dim}│${RESET}`,
        ` ${C.dim}└${"─".repeat(inner)}┘${RESET}`,
        `   ${C.grey}Auto · 2 files edited${RESET}`,
      ];
    },
    promptGlyph: ` ${C.dim}│${RESET} ${C.purple}→ `,
    inputLineFromBottom: 2,
  },
};
const look = LOOK[agent];

// ── animation state ───────────────────────────────────────────────────────
let frame = 0;
const blink = () => frame % 6 < 3;
let phase = "boot";
let workStart = Date.now();
let tokens = 0.4;
let verb = "Clauding";
let typed = "";
let running = null; // tool event currently "running"
let streaming = null; // partial assistant text
let approvalShown = null;

function spinnerLine() {
  const secs = Math.max(1, Math.round((Date.now() - workStart) / 1000 / SLOWMO));
  return look.spinner(verb, secs, `${tokens.toFixed(1)}k`);
}

function workingLive(w) {
  const lines = [];
  if (streaming) lines.push(...look.say(streaming, contentWidth(), true), "");
  if (running) lines.push(...look.tool(running, contentWidth(), "running"), "");
  lines.push(spinnerLine(), "");
  lines.push(...look.input(w, "", scenario.ctx));
  return lines;
}

function inputLive(w) {
  return look.input(w, typed, scenario.ctx);
}

function setLive(fn) {
  liveFn = fn;
  drawLive();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits `ms`, but gives up early once the recorder queued a command, so
// "finish" and "approve" land when the storyboard asks for them.
async function waitOrCommand(ms) {
  const until = Date.now() + ms * SLOWMO;
  while (Date.now() < until && pending.length === 0) await sleep(40);
}

// ── control channel ───────────────────────────────────────────────────────
const pending = [];
function pollControl() {
  const file = join(DEMO_DIR, "ctl", stateKey);
  if (!existsSync(file)) return;
  try {
    const text = readFileSync(file, "utf8");
    rmSync(file, { force: true });
    for (const cmd of text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      // Pace changes apply at once; the rest waits for the playback loop.
      if (cmd === "slow") tick = SLOW_TICK;
      else if (cmd === "fast") tick = scenario.tick ?? FAST_TICK;
      else pending.push(cmd);
    }
  } catch {
    // Retry on the next tick.
  }
}
setInterval(pollControl, 80);

let approvalAccepted = null;
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  const text = data.toString("utf8");
  if (approvalShown && /[1\r]/.test(text)) {
    approvalAccepted?.();
  }
  // Everything else (Ctrl+C included) is ignored: the agent never exits.
});

// ── resize ────────────────────────────────────────────────────────────────
let resizeTimer = null;
function onResize() {
  let size;
  try {
    size = process.stdout.getWindowSize();
  } catch {
    return;
  }
  const [c, r] = size;
  if (c === cols && r === rows) return;
  cols = c;
  rows = r;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    redrawAll();
    report(phase);
  }, 30);
}
process.stdout.on("resize", onResize);
setInterval(onResize, 100);

// ── spinner ticker ────────────────────────────────────────────────────────
// Agents nobody is looking at tick slowly: every repaint costs the recorded
// renderer a frame, and the app only needs some output to keep them "working".
const FAST_TICK = 110;
const SLOW_TICK = 700;
let tick = scenario.tick ?? FAST_TICK;
function spin() {
  frame += 1;
  if (phase === "working") {
    tokens += 0.013 + Math.random() * 0.02;
    drawLive();
  }
  setTimeout(spin, tick * SLOWMO);
}
setTimeout(spin, tick * SLOWMO);

// ── playback ──────────────────────────────────────────────────────────────
async function streamSay(text) {
  const words = text.split(" ");
  for (let i = 1; i <= words.length; i += 2) {
    streaming = words.slice(0, i).join(" ");
    drawLive();
    await sleep(55 * SLOWMO);
  }
  streaming = null;
  commit((w) => look.say(text, w));
}

async function play(ev) {
  if (ev.think) {
    verb = ev.verb ?? verb;
    await waitOrCommand(ev.think);
    return;
  }
  if (ev.say) {
    await streamSay(ev.say);
    await sleep(250 * SLOWMO);
    return;
  }
  if (ev.todos) {
    commit(() => look.todos(ev.todos));
    await sleep(350 * SLOWMO);
    return;
  }
  if (ev.tool || ev.run) {
    const toolEv = ev.run ? { tool: "Bash", arg: ev.run, ...ev } : ev;
    running = toolEv;
    drawLive();
    await waitOrCommand(ev.ms ?? 800);
    running = null;
    if (ev.touch) {
      try {
        appendFileSync(join(process.cwd(), ev.touch), `\n// ${scenario.title}\n`);
      } catch {
        // Not a real repository: nothing to dirty.
      }
    }
    commit((w) => look.tool(toolEv, w, "done"));
    await sleep(300 * SLOWMO);
  }
}

async function typePrompt(text) {
  phase = "typing";
  report(phase);
  typed = "";
  for (const ch of text) {
    typed += ch;
    drawLive();
    await sleep((22 + Math.random() * 30) * SLOWMO);
  }
  await sleep(250 * SLOWMO);
  typed = "";
}

async function goIdle() {
  phase = "done";
  idleCursor = true;
  liveFn = inputLive;
  drawLive();
  report(phase);
}

async function showApproval() {
  phase = "approval";
  approvalShown = scenario.approval;
  liveFn = (w) => look.approval(scenario.approval, w);
  // Silence after this: "Do you want" and "❯ 1." must stay the tail.
  drawLive();
  report(phase);
  await new Promise((resolve) => {
    approvalAccepted = resolve;
  });
  approvalShown = null;
  approvalAccepted = null;
  phase = "working";
  report(phase);
  liveFn = workingLive;
  drawLive();
}

async function main() {
  report("boot");
  writeTranscript();
  out(`${ESC}?25l${ESC}2J${ESC}3J${ESC}H`);
  commit((w) => look.banner(w));
  if (scenario.idle) {
    await goIdle();
    return;
  }
  // A real agent sits at its prompt until someone types. That quiet moment
  // also matters to the app: it only trusts unrecognized output as "work"
  // after the spawn burst has gone silent for a beat.
  if (scenario.typePrompt) {
    typed = "";
    setLive(inputLive);
    await sleep(1800);
    await typePrompt(scenario.prompt);
    commit((w) => look.user(scenario.prompt, w));
  } else {
    commit((w) => look.user(scenario.prompt, w));
    setLive(inputLive);
    await sleep(1800);
  }
  phase = "working";
  workStart = Date.now() - (scenario.typePrompt ? 0 : 20_000 + Math.random() * 60_000) * SLOWMO;
  tokens = scenario.typePrompt ? 0.2 : 3 + Math.random() * 4;
  verb = agent === "codex" ? "Working" : agent === "cursor" ? "Generating" : "Clauding";
  setLive(workingLive);
  report(phase);

  const queue = [...scenario.steps];
  let loopIndex = 0;
  for (;;) {
    const command = pending.shift();
    if (command === "finish") break;
    if (command === "approve" && scenario.approval) {
      await showApproval();
      queue.push(...(scenario.afterApproval ?? []));
      continue;
    }
    const ev = queue.shift() ?? scenario.loop[loopIndex++ % Math.max(1, scenario.loop.length)];
    if (!ev) {
      await sleep(200);
      continue;
    }
    await play(ev);
  }
  for (const ev of scenario.finish) await play(ev);
  await goIdle();
}

main().catch((error) => {
  out(`\r\n${C.red}fake agent crashed: ${error?.stack ?? error}${RESET}\r\n`);
  setInterval(() => {}, 1 << 30);
});
