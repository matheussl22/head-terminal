import type { BlockedReason, PaneBlock } from "../types/activity";
import type { AgentHookEvent } from "../types/agent-hooks";
import { parseClaudeFolderTrust } from "./claude-folder-trust";
import { compactRow, unboxRow, type ScreenSnapshot } from "./terminal-screen";

/**
 * Pure classifiers behind the pane status (see ActivityDetector). Each one
 * turns one real signal — a terminal title, the rendered screen, a hook event,
 * a key the user sent — into a small verdict. None of them looks at how much
 * output there was or how long it has been quiet: all three agent CLIs are
 * byte-for-byte silent both when idle and when blocked on a dialog, and they
 * repaint on every keystroke and resize, so volume and silence say nothing.
 *
 * Every string matched here was captured from the real CLIs through ConPTY
 * (Claude Code 2.1.283, codex-cli 0.155.1, cursor-agent 2026.09.23).
 */

export type AgentFamily = "claude" | "codex" | "cursor";
/** "shell" covers every pane without a known agent UI: plain shells, ollama,
 * llama.cpp, antigravity — and any agent pane after it fell back to its shell. */
export type SignalFamily = AgentFamily | "shell";

export function profileFamily(agentProfileId: string): SignalFamily {
  switch (agentProfileId) {
    case "claude":
    case "codex":
    case "cursor":
      return agentProfileId;
    default:
      return "shell";
  }
}

// ---------------------------------------------------------------------------
// Titles (OSC 0/2, via xterm's onTitleChange)
// ---------------------------------------------------------------------------

export interface TitleSignal {
  family: AgentFamily;
  /**
   * - working / idle / blocked / starting: what the agent says it is doing.
   *   Claude's "idle" only means "not working": its title reads the same at
   *   the prompt and on an open permission dialog.
   * - ready: the agent's UI is up but its title carries no state (cursor-agent
   *   without status indicators).
   * - keep: a transient state that says nothing new (cursor "Reconnecting").
   */
  state: "working" | "idle" | "blocked" | "starting" | "ready" | "keep";
  reason?: BlockedReason;
}

// Claude Code: "◐ <session>" / "◑ <session>" while working (alternating about
// once a second, long tools included), "✳ <session>" otherwise.
const CLAUDE_WORKING_TITLE = /^[\u25D0-\u25D3] /u;
const CLAUDE_IDLE_TITLE = /^\u2733 /u;

// cursor-agent with display.showStatusIndicators: "<chat> - <emoji> <label>",
// with " (<worktree>)" appended when in a worktree.
const CURSOR_STATUS_TITLE =
  /^.* - (📤|📂|🔄|⌨️?|🧭|⏳|📋|❓|🔐|📝|✅)\uFE0F? .+$/u;

// Codex: "[ ! ] Action Required" / "[ . ] Action Required" blinks while it
// waits for the user; a braille spinner leads the title while it works.
const CODEX_ACTION_REQUIRED = /\[ [!.] \] Action Required/;
const CODEX_SPINNER_LEAD = /^[\u2800-\u28FF]/u;
// Run-state first with more items after it: "Working ⠇ 01a0db3d… ⠇".
const CODEX_RUN_STATE_SPINNING = /^(Starting|Working|Thinking|Waiting) [\u2800-\u28FF](?: |$)/u;
// The run-state item of `tui.terminal_title` as its own leading segment
// ("⠋ Working | proj", "Working ⠋", "⠙ Starting", "Ready"). Matching the
// whole segment keeps an idle thread called "Working on X | proj" idle.
// "Waiting" is codex waiting on a background terminal — still work.
const CODEX_RUN_STATE =
  /^(?:[\u2800-\u28FF] )?(Starting|Working|Thinking|Waiting|Ready)(?: [\u2800-\u28FF])?(?: \||$)/u;

/** Titles a console sets on its own: the shell's executable path (ConPTY at
 * spawn and again once an agent exits), a login shell's "user@host: dir"… */
const SHELL_TITLE_PATTERNS = [
  /^[A-Za-z]:\\/,
  /\.(exe|com|cmd|bat|ps1)$/i,
  /^(Administrator|Administrador|Admin):\s/i,
  /^(Windows PowerShell|PowerShell|pwsh|powershell|cmd|bash|zsh|fish|sh|nu|wsl)(\s|$)/i,
  /^[\w.-]+@[\w.-]+(:|\s|$)/,
  /^~(\/|$)/,
  /^\/\S*$/,
];

/** Bare program names: the console title while a CLI boots ("claude" is
 * ConPTY's first title in every Claude pane). Not a state either way. */
const PROGRAM_NAME_TITLE = /^(claude|codex|cursor-agent|agent|agy|node|ollama)$/i;

export function isShellTitle(title: string): boolean {
  return SHELL_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

function cursorStatus(emoji: string): TitleSignal {
  switch (emoji.replace(/\uFE0F/gu, "")) {
    case "🔐":
      return { family: "cursor", state: "blocked", reason: "approval" };
    case "❓":
      return { family: "cursor", state: "blocked", reason: "question" };
    case "✅":
      return { family: "cursor", state: "idle" };
    case "📂":
      return { family: "cursor", state: "starting" };
    case "🔄":
      return { family: "cursor", state: "keep" };
    default:
      // ⏳ working, ⌨ shell command, 🧭 planning, 📋 queued, 📤 moving to
      // cloud, 📝 reviewing changes: the turn is still in flight.
      return { family: "cursor", state: "working" };
  }
}

/**
 * What a terminal title says about the agent behind it, or null when it is
 * not an agent's status title (a shell path, a bare program name, "").
 *
 * `context` is the family that currently owns the pane's title. Codex's idle
 * title is just the project/thread name and cursor's plain title is the chat
 * name — only recognizable once we know that agent is the one talking.
 */
export function classifyTitle(title: string, context?: SignalFamily): TitleSignal | null {
  const text = title.trim();
  if (!text) {
    return null;
  }

  // The agents' own status shapes come first: a session or chat named
  // "Deploy mysite.com", "Fix install.ps1" or "Bash deploy script" is still
  // the agent talking, not a shell that took the title back.
  if (CLAUDE_WORKING_TITLE.test(text)) {
    return { family: "claude", state: "working" };
  }
  if (CLAUDE_IDLE_TITLE.test(text)) {
    return { family: "claude", state: "idle" };
  }

  const cursor = CURSOR_STATUS_TITLE.exec(text);
  if (cursor) {
    return cursorStatus(cursor[1]);
  }

  if (CODEX_ACTION_REQUIRED.test(text)) {
    return { family: "codex", state: "blocked" };
  }
  const runState = (CODEX_RUN_STATE.exec(text) ?? CODEX_RUN_STATE_SPINNING.exec(text))?.[1];
  if (runState === "Starting") {
    return { family: "codex", state: "starting" };
  }
  if (runState === "Ready") {
    return { family: "codex", state: "idle" };
  }
  if (runState || CODEX_SPINNER_LEAD.test(text)) {
    return { family: "codex", state: "working" };
  }

  if (isShellTitle(text) || PROGRAM_NAME_TITLE.test(text)) {
    return null;
  }
  if (context === "codex") {
    // Default title format: no spinner in front means codex is idle —
    // including "renaming... ⠦ | proj", whose spinner is not the lead.
    return { family: "codex", state: "idle" };
  }

  if (context === "cursor") {
    // "Cursor Agent" or the chat name: the TUI is up, nothing more.
    return { family: "cursor", state: "ready" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The rendered screen
// ---------------------------------------------------------------------------

export interface ScreenSignal {
  /** starting: the agent is up but still loading (cursor "Trusting
   * workspace..."). null: nothing on screen says anything. */
  state: "working" | "blocked" | "idle" | "starting" | null;
  reason?: BlockedReason;
  detail?: string;
}

const NO_SIGNAL: ScreenSignal = { state: null };

function nonEmptyRows(rows: string[]): string[] {
  return rows.filter((row) => row.trim().length > 0);
}

/** The last `count` non-empty rows. Dialogs sit at the very bottom, their
 * footer on the last line: looking only there keeps a phrase that scrolled
 * into the transcript from reading as a live dialog. */
function bottomRows(rows: string[], count: number): string[] {
  return nonEmptyRows(rows).slice(-count);
}

function lastIndexOf(rows: string[], test: (row: string) => boolean): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (test(rows[index])) {
      return index;
    }
  }
  return -1;
}

/** Rows joined with single spaces: a phrase an agent wrapped across two rows
 * in a narrow pane still reads whole. */
function flatten(rows: string[]): string {
  return rows
    .map((row) => row.trim())
    .join(" ")
    .replace(/\s+/gu, " ");
}

const DIALOG_ROWS = 16;
const FOOTER_ROWS = 3;

// Claude Code's Select: "❯ 1. Yes" (U+276F) on the highlighted option.
const CLAUDE_SELECTOR = /^\s*❯\s*\d+\.\s*\S/u;
const CLAUDE_CHECKBOX = /^\s*[☐☒✔✓]\s/u;
const CLAUDE_TOOL_CALL = /^\s*[●⏺]\s*([A-Z][\w]*)\(/u;
const HORIZONTAL_RULE = /^\s*[─━]{8,}\s*$/u;
/** Rows a tool call's own line ("● Write(C:\…\long\path)") may wrap onto in
 * a narrow pane, between it and the dialog. */
const CLAUDE_TOOL_CALL_ROWS = 3;
/** Transcript rows that are not the tail of a wrapped tool call: a tool's
 * result ("⎿"), an echoed prompt ("❯"), an answer ("●"). */
const CLAUDE_NOT_TOOL_TAIL = /^\s*[⎿❯●⏺]|^\S/u;

/**
 * The tool an approval dialog asks about, when the call sits right above the
 * dialog's top rule ("● Write(probe.txt)", then the rule). Claude 2.1.283
 * draws no such row for a Bash request ("⎿ $ cmd" comes first): an older
 * call further up the transcript is not the one asked about, so anything but
 * a call right there says nothing. `rows` are the screen's non-empty rows,
 * `selector` the index of the dialog's selected option.
 */
function claudeToolAboveDialog(rows: string[], selector: number): string | undefined {
  const rule = lastIndexOf(rows.slice(0, selector), (row) => HORIZONTAL_RULE.test(row));
  if (rule < 0) {
    return undefined;
  }
  for (let index = rule - 1; index >= Math.max(0, rule - 1 - CLAUDE_TOOL_CALL_ROWS); index -= 1) {
    const call = CLAUDE_TOOL_CALL.exec(rows[index]);
    if (call) {
      return call[1];
    }
    if (CLAUDE_NOT_TOOL_TAIL.test(rows[index])) {
      return undefined;
    }
  }
  return undefined;
}

/** The footers Claude's dialogs end on. */
const CLAUDE_DIALOG_FOOTER = /\b(?:Esc to cancel|Enter to select|Enter to confirm)\b/i;
/** The REPL's own footer: idle ("? for shortcuts") or mid-turn. */
const CLAUDE_REPL_FOOTER = /\? for shortcuts|\besc to interrupt\b/i;
/** Rows the REPL may show under its input box: the mode line, a
 * notification, the slash-command suggestions. */
const CLAUDE_UNDER_INPUT_ROWS = 8;
/** Rows a typed prompt may wrap onto inside the input box. */
const CLAUDE_INPUT_ROWS = 10;
/** How far below "Would you like to proceed?" the selected plan option can
 * be: four options, some wrapped in a narrow pane. */
const CLAUDE_PLAN_OPTION_ROWS = 6;

/** Claude's input box at the bottom of the screen: a rule, the ❯ row (and
 * the rows a long prompt wrapped onto), a rule, then only what the REPL
 * shows under it. `rows` are the non-empty bottom rows. */
function claudeInputBox(rows: string[]): boolean {
  const lowest = Math.max(1, rows.length - 1 - CLAUDE_UNDER_INPUT_ROWS);
  for (let lower = rows.length - 1; lower >= lowest; lower -= 1) {
    if (!HORIZONTAL_RULE.test(rows[lower])) {
      continue;
    }
    // A question's options can straddle a rule too ("  4. Chat about this"
    // under it), but a dialog footer never sits under the input box.
    if (CLAUDE_DIALOG_FOOTER.test(flatten(rows.slice(lower + 1)))) {
      return false;
    }
    const highest = Math.max(0, lower - 1 - CLAUDE_INPUT_ROWS);
    for (let upper = lower - 1; upper >= highest; upper -= 1) {
      if (HORIZONTAL_RULE.test(rows[upper])) {
        return upper < lower - 1 && /^\s*❯/u.test(rows[upper + 1]);
      }
    }
    return false;
  }
  return false;
}

/**
 * Claude Code's plan approval: "Would you like to proceed?" with the
 * selector on one of the options right under it. The selector has to come
 * after the question — a numbered prompt echoed in the transcript ("❯ 1. …")
 * above a closing "Would you like to proceed?" is not a dialog.
 */
function claudePlanPrompt(rows: string[]): boolean {
  // The row the question ends on, even wrapped in a narrow pane.
  const question = lastIndexOf(rows, (row) => /proceed\?/i.test(row));
  const asked = flatten(rows.slice(Math.max(0, question - 2), question + 1));
  if (question < 0 || !/Would you like to proceed\?/i.test(asked)) {
    return false;
  }
  const options = rows.slice(question + 1, question + 1 + CLAUDE_PLAN_OPTION_ROWS);
  const selector = options.findIndex((row) => CLAUDE_SELECTOR.test(row));
  return selector >= 0 && !options.slice(0, selector).some((row) => HORIZONTAL_RULE.test(row));
}

/** The first spawn on a fresh Claude profile walks through onboarding
 * before any REPL: the theme ("Let's get started." / "Choose the text style
 * that looks best with your terminal"), then "Select login method:". Each is
 * a selector with no dialog footer, waiting on the user all the same. The
 * theme's options sit above a code preview that grows as a narrow pane wraps
 * it, so heading and selector are looked for on the whole screen (only ever
 * without a REPL on it). */
const CLAUDE_ONBOARDING = /Let's get started|Choose the text style|Select login method/i;

function claudeOnboarding(rows: string[]): boolean {
  const painted = nonEmptyRows(rows);
  return painted.some((row) => CLAUDE_SELECTOR.test(row)) && CLAUDE_ONBOARDING.test(flatten(painted));
}

export function classifyClaudeScreen(snapshot: ScreenSnapshot): ScreenSignal {
  const dialog = bottomRows(snapshot.rows, DIALOG_ROWS);
  const footer = flatten(bottomRows(snapshot.rows, FOOTER_ROWS));

  // Every dialog replaces the input box and its footer: while the REPL is on
  // screen, whatever reads like a dialog above it is the transcript — an
  // answer quoting one, a numbered prompt echoed as "❯ 1. …", or the user
  // typing "1. sim" into the box.
  const replFooter = CLAUDE_REPL_FOOTER.test(footer);
  const inputBox = claudeInputBox(dialog);
  if (!replFooter && !inputBox) {
    // Workspace trust ("❯ No, exit" / "Yes, I trust this folder" on
    // 2.1.283; "Do you trust the files in this folder?" on older builds),
    // anchored the same way the auto-accept reads it.
    if (parseClaudeFolderTrust(snapshot)) {
      return { state: "blocked", reason: "dialog" };
    }

    const selector = dialog.some((row) => CLAUDE_SELECTOR.test(row));
    const cancelFooter = /\bEsc to cancel\b/i.test(footer);
    const selectFooter = /\bEnter to select\b/i.test(footer);
    const planPrompt = claudePlanPrompt(dialog);
    if (selector && (cancelFooter || selectFooter || planPrompt)) {
      if (selectFooter || dialog.some((row) => CLAUDE_CHECKBOX.test(row))) {
        return { state: "blocked", reason: "question" };
      }
      if (planPrompt) {
        return { state: "blocked", reason: "question", detail: "plano" };
      }
      const rows = nonEmptyRows(snapshot.rows);
      const selected = lastIndexOf(rows, (row) => CLAUDE_SELECTOR.test(row));
      return { state: "blocked", reason: "approval", detail: claudeToolAboveDialog(rows, selected) };
    }
    if (claudeOnboarding(snapshot.rows)) {
      return { state: "blocked", reason: "dialog" };
    }
  }

  // Only trusted when the pane never got a Claude status title (the title is
  // authoritative otherwise): the footer reads "esc to interrupt" mid-turn.
  if (/\besc to interrupt\b/i.test(footer)) {
    return { state: "working" };
  }
  if (/\? for shortcuts/.test(footer) || inputBox) {
    return { state: "idle" };
  }
  return NO_SIGNAL;
}

export function classifyCodexScreen(snapshot: ScreenSnapshot): ScreenSignal {
  const dialog = flatten(bottomRows(snapshot.rows, DIALOG_ROWS));
  const footer = flatten(bottomRows(snapshot.rows, FOOTER_ROWS));

  // Every blocking overlay ends on one of these footers — the approval
  // dialogs, request_user_input and the startup screens (update available,
  // directory trust, hooks review), which never touch the title. A narrow
  // pane truncates the footer rather than wrapping it: "Press enter to c".
  if (/Press enter to\b|enter to submit answer/i.test(footer)) {
    if (/Would you like to run the following command\?/i.test(dialog)) {
      return { state: "blocked", reason: "approval", detail: "comando" };
    }
    if (/Would you like to make the following edits\?/i.test(dialog)) {
      return { state: "blocked", reason: "approval", detail: "edição" };
    }
    if (/\bQuestion \d+\/\d+/.test(dialog)) {
      return { state: "blocked", reason: "question" };
    }
    return { state: "blocked", reason: "dialog" };
  }
  // No footer, no dialog: a "Question 2/5" without "enter to submit answer"
  // under it is the transcript (codex echoes every prompt as "› …").

  // "• Working (12s • esc to interrupt)" — only used without codex titles.
  if (/esc to interrupt\)/i.test(dialog)) {
    return { state: "working" };
  }
  if (/Ask Codex to do anything|\? for shortcuts/i.test(dialog)) {
    return { state: "idle" };
  }
  return NO_SIGNAL;
}

// "⠠⠜ Working  16 tokens", "⠀⠞ Thinking", "⠘⠣ Editing", "⠠⠛ Running"…
// but not "⠘⠆ Reconnecting (attempt 1, 1s)": cursor repaints that for a
// while after a finished turn. A reconnect in mid-turn still shows "ctrl+c
// to stop" on the prompt row (and the 🔄 title is "keep" for the same reason).
const CURSOR_SPINNER_ROW = /^\s*[\u2800-\u28FF]{1,2}\s+(?!Reconnecting\b)[A-Z][a-z]+/u;
const CURSOR_PROMPT_ROW = /^\s*→\s/u;
// The workspace trust box: "▶ [a] Trust this workspace" on the highlighted
// option. Under 34 columns the option wraps inside the box ("│ ▶ [a] Trust
// this │" / "│ workspace │", at 18 even "this wor" / "kspace"), so the box is
// read without its edges and its spaces.
const CURSOR_TRUST_PHRASE = "trustthisworkspace";
const CURSOR_TRUST_SELECTOR = /▶\[[a-z]\]/u;
const CURSOR_BOX_RULE_ROW = /^\s*[╭╰┌└][─━]+[╮╯┐┘]\s*$/u;
/** The box's bottom edge — or its tail, the edge wrapped when the pane
 * narrowed before cursor repainted. */
const CURSOR_BOX_BOTTOM_ROW = /^\s*(?:[╰└][─━]*[╯┘]?|[─━]*[╯┘])\s*$/u;
/** At 18 columns the highlighted option already sits 16 rows up from the
 * bottom of the box ("▶ [a]" / "Trust" / "this wor" / "kspace", then the
 * wrapped "[q] Quit" and help text): some slack for narrower still. */
const CURSOR_TRUST_ROWS = 24;

// The shell approval: "Run this command?" on its own row, then its options
// ("→ Run (once) (y)" … "Skip & tell the agent what to do instead (esc or
// n)") at the very bottom.
const CURSOR_RUN_QUESTION = /^\s*Run this command\?\s*$/u;
const CURSOR_RUN_OPTION = /^\s*(?:→\s*)?Run \(once\)|Skip & tell the agent/u;
// After Esc on it, the prompt row itself asks for the correction…
const CURSOR_CORRECTION_ROW = /^\s*→\s*Tell the agent what to do instead\b/u;
// …and once the user types it, only the layout says so: the pending tool
// row, the command's box right under it, then the prompt's box.
const CURSOR_PENDING_TOOL_ROW = /^\s*\$\s.*\sWaiting for approval\.\.\.\s*$/u;
const CURSOR_COMMAND_BOX_TOP = /^\s*┌/u;
const CURSOR_BOX_ROW = /^\s*[┌│└▄]/u;
// AskQuestion's box: "│ Question 1 of 1 │" … "│ ↑/↓ option · … · Esc to skip │".
const CURSOR_QUESTION_ROW = /^\s*│?\s*Question \d+ of \d+\s*│?\s*$/u;
const CURSOR_QUESTION_FOOTER = /Enter next\/submit|Esc to skip/u;
/** The approval's options, and the correction prompt with the status rows
 * cursor may draw under it, all fit in the last few rows. */
const CURSOR_DIALOG_TAIL_ROWS = 6;
/** "Run this command?" sits above an allowlist note and four options, some
 * of them wrapped in a narrow pane. */
const CURSOR_RUN_QUESTION_ROWS = 10;

/** The correction prompt with the user's answer typed over its placeholder. */
function cursorCorrectionTyped(rows: string[]): boolean {
  const tool = lastIndexOf(rows, (row) => CURSOR_PENDING_TOOL_ROW.test(row));
  if (tool < 0 || !CURSOR_COMMAND_BOX_TOP.test(rows[tool + 1] ?? "")) {
    return false;
  }
  let index = tool + 1;
  while (index < rows.length && CURSOR_BOX_ROW.test(rows[index])) {
    index += 1;
  }
  return index < rows.length && CURSOR_PROMPT_ROW.test(rows[index]);
}

function cursorApproval(rows: string[]): boolean {
  const tail = rows.slice(-CURSOR_DIALOG_TAIL_ROWS);
  if (tail.some((row) => CURSOR_CORRECTION_ROW.test(row)) || cursorCorrectionTyped(rows)) {
    return true;
  }
  const option = lastIndexOf(rows, (row) => CURSOR_RUN_OPTION.test(row));
  if (option < 0 || option < rows.length - CURSOR_DIALOG_TAIL_ROWS) {
    return false;
  }
  const question = lastIndexOf(rows.slice(0, option), (row) => CURSOR_RUN_QUESTION.test(row));
  return question >= 0 && option - question <= CURSOR_RUN_QUESTION_ROWS;
}

/** The trust box's live dialog: the box is the last thing on screen, its
 * highlighted option still marked. The box's own rows ("│      │",
 * "╰────╯") are dropped before counting the bottom rows: at 18 columns they
 * would push the option out of them. */
function cursorTrustDialog(rows: string[]): boolean {
  const painted = nonEmptyRows(rows);
  if (!CURSOR_BOX_BOTTOM_ROW.test(painted.at(-1) ?? "")) {
    return false;
  }
  const inner = painted
    .map(unboxRow)
    .filter((row) => row.trim() && !CURSOR_BOX_RULE_ROW.test(row));
  const text = inner.slice(-CURSOR_TRUST_ROWS).map(compactRow).join("");
  return text.includes(CURSOR_TRUST_PHRASE) && CURSOR_TRUST_SELECTOR.test(text);
}

function cursorQuestion(rows: string[]): boolean {
  const footer = flatten(rows.slice(-FOOTER_ROWS));
  return CURSOR_QUESTION_FOOTER.test(footer) && rows.some((row) => CURSOR_QUESTION_ROW.test(row));
}

export function classifyCursorScreen(snapshot: ScreenSnapshot): ScreenSignal {
  const dialogRows = bottomRows(snapshot.rows, DIALOG_ROWS);
  const dialog = flatten(dialogRows);

  // Only the live dialogs at the bottom: cursor echoes every prompt, so
  // their phrases can be anywhere in the transcript.
  if (cursorApproval(dialogRows)) {
    return { state: "blocked", reason: "approval" };
  }
  if (cursorQuestion(dialogRows)) {
    return { state: "blocked", reason: "question" };
  }
  // The trust box stays on screen after "a" was pressed (and after the TUI
  // came up), minus the ▶ on the highlighted option.
  if (cursorTrustDialog(snapshot.rows)) {
    return { state: "blocked", reason: "dialog" };
  }

  if (
    dialogRows.some((row) => CURSOR_SPINNER_ROW.test(row)) ||
    /ctrl\+c to stop/i.test(dialog)
  ) {
    return { state: "working" };
  }
  const prompt = dialogRows.some((row) => CURSOR_PROMPT_ROW.test(row));
  if (prompt) {
    return { state: "idle" };
  }
  if (/Trusting workspace\.\.\./i.test(dialog)) {
    return { state: "starting" };
  }
  return NO_SIGNAL;
}

export function classifyScreen(family: SignalFamily, snapshot: ScreenSnapshot): ScreenSignal {
  switch (family) {
    case "claude":
      return classifyClaudeScreen(snapshot);
    case "codex":
      return classifyCodexScreen(snapshot);
    case "cursor":
      return classifyCursorScreen(snapshot);
    default:
      return NO_SIGNAL;
  }
}

// ---------------------------------------------------------------------------
// Shell prompts
// ---------------------------------------------------------------------------

// PowerShell "PS C:\x> ", bash "$ ", root "# ", zsh "% ", starship "❯ ",
// "› ", ollama ">>> ", llama.cpp "> ", "λ ", "» ".
const SHELL_PROMPT = /(?:^PS [^\r\n]*>|[$#%❯›>λ»])\s?$/u;

/** The first run of non-space characters, when it is a symbol ("➜" of
 * oh-my-zsh, "λ", "[") — letters would match ordinary output. */
export function promptSigil(line: string): string | null {
  const head = /^\s*(\S{1,3})/u.exec(line)?.[1];
  return head && !/^[\p{L}\p{N}]/u.test(head) ? head : null;
}

/**
 * Whether the cursor sits right after a shell prompt. `learnedPrompt` is the
 * cursor line the pane showed when its shell first came up: a prompt the
 * pattern does not know ("➜  proj git:(main) ✗ ") is still recognized by its
 * leading symbol.
 */
export function isShellPromptAtCursor(snapshot: ScreenSnapshot, learnedPrompt?: string): boolean {
  if (snapshot.altScreen) {
    return false;
  }
  const line = snapshot.cursorLine;
  if (!line.trim()) {
    return false;
  }
  if (SHELL_PROMPT.test(line)) {
    return true;
  }
  const sigil = learnedPrompt ? promptSigil(learnedPrompt) : null;
  return sigil !== null && promptSigil(line) === sigil && /\s$/u.test(line);
}

/** Profiles whose pane runs a local model's REPL, not a shell: ollama and
 * llama.cpp in conversation mode (Ornith, Qwen 27B). */
const REPL_PROFILES = new Set(["ollama", "ornith", "qwen27"]);

export function isReplProfile(agentProfileId: string): boolean {
  return REPL_PROFILES.has(agentProfileId);
}

// ollama ">>> ", llama.cpp "> " — the whole cursor line (ollama's gray
// placeholder sits after the cursor). A model streams "=>", "<div>", "50%"
// or a markdown "#" and pauses between tokens; none of that is its prompt.
const REPL_PROMPT = /^(?:>>>|>)\s?$/u;

/** Whether the cursor sits right after a local model REPL's own prompt,
 * which it only prints once the answer is complete. */
export function isReplPromptAtCursor(snapshot: ScreenSnapshot): boolean {
  return !snapshot.altScreen && REPL_PROMPT.test(snapshot.cursorLine);
}

// ---------------------------------------------------------------------------
// Hooks (Claude Code, see electron/services/agent-hook-server.ts)
// ---------------------------------------------------------------------------

export type HookSignal =
  /** The agent is blocked on the user. `weak`: only a reminder that a dialog
   * is (still) open — it must not overwrite a more precise block. */
  | { kind: "blocked"; block: PaneBlock; weak?: boolean }
  /** Work (re)started: whatever dialog there was has been answered. */
  | { kind: "resume" }
  /** The turn ended. */
  | { kind: "stop" }
  | { kind: "ignore" };

/** How a tool reads in "pede aprovação (…)": the tool name, except where it
 * would be noise to a person. */
export function formatToolDetail(toolName: string | undefined): string | undefined {
  if (!toolName || toolName === "AskUserQuestion") {
    return undefined;
  }
  if (toolName === "ExitPlanMode") {
    return "plano";
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) {
    return `${mcp[1]} · ${mcp[2]}`;
  }
  return toolName;
}

const QUESTION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

export function classifyHookEvent(event: AgentHookEvent): HookSignal {
  switch (event.event) {
    case "PermissionRequest":
      return {
        kind: "blocked",
        block: {
          reason: event.toolName && QUESTION_TOOLS.has(event.toolName) ? "question" : "approval",
          detail: formatToolDetail(event.toolName),
        },
      };
    case "Notification":
      switch (event.notificationType) {
        case "permission_prompt":
          // Fires ~6 s into an open dialog (AskUserQuestion included).
          return { kind: "blocked", block: { reason: "approval" }, weak: true };
        case "elicitation_dialog":
        case "elicitation_url_dialog":
        case "agent_needs_input":
          return { kind: "blocked", block: { reason: "question" } };
        default:
          // idle_prompt arrives ~60 s after a finished turn: the agent is
          // idle, not waiting on anybody. Reading it as "waiting" is exactly
          // the bogus "Aguardando" this engine exists to remove.
          return { kind: "ignore" };
      }
    case "Elicitation":
      return { kind: "blocked", block: { reason: "question" } };
    case "ElicitationResult":
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PostToolBatch":
    case "PreCompact":
      return { kind: "resume" };
    case "Stop":
    case "StopFailure":
      return { kind: "stop" };
    default:
      // SubagentStop (Claude sends an empty one after every turn),
      // SessionEnd (the pty exit covers it), SessionStart…
      return { kind: "ignore" };
  }
}

// ---------------------------------------------------------------------------
// What the user sent
// ---------------------------------------------------------------------------

// Answers xterm writes on its own behalf: cursor position and device
// attribute reports, DEC mode reports, OSC color replies, DCS replies, focus.
const TERMINAL_REPLY =
  /^(?:\x1b\[\??\d+(?:;\d+)*R|\x1b\[[?>=]?[\d;]*c|\x1b\[\d*n|\x1b\[\??[\d;]*\$y|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[\s\S]*?\x1b\\|\x1b\[[IO])+$/;

/** Data xterm sends to the pty that no person typed. */
export function isTerminalReply(data: string): boolean {
  return TERMINAL_REPLY.test(data);
}

export type UserKey = "enter" | "escape" | "interrupt" | "digit" | "other";

/** A bracketed paste (xterm wraps pasted text in these when the app turned
 * ?2004h on): the shell or agent only fills its line editor with it. */
const BRACKETED_PASTE = /\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)/g;

/** The keys that can answer a dialog. Arrow keys and typing only move
 * around inside it. */
export function classifyUserKey(data: string): UserKey {
  if (data === "\x1b") {
    return "escape";
  }
  if (data.includes("\x03")) {
    return "interrupt";
  }
  if (/^[0-9]$/.test(data)) {
    return "digit";
  }
  // Pasting never submits: only a \r outside the paste brackets is Enter.
  // An unbracketed paste ("a\rb") does run, and counts.
  const typed = data.replace(BRACKETED_PASTE, "");
  if (typed.includes("\r") && !isTerminalReply(data)) {
    return "enter";
  }
  return "other";
}
