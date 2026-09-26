import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_FOLDER_TRUST_CONFIRM_KEY,
  CLAUDE_FOLDER_TRUST_DOWN_KEY,
  CLAUDE_FOLDER_TRUST_UP_KEY,
  ClaudeFolderTrustAutoAccept,
  parseClaudeFolderTrust,
} from "./claude-folder-trust";
import { classifyClaudeScreen } from "./activity-signals";
import { SpawnScreenReader, type ScreenSnapshot, type ScreenSource } from "./terminal-screen";

function screen(rows: string[]): ScreenSnapshot {
  return { rows, cursorLine: "", altScreen: false };
}

// Claude Code 2.1.283, as rendered: "No, exit" comes first and preselected.
const header = [
  " Accessing workspace:",
  " C:\\Users\\mathe\\proj",
  " Quick safety check: Is this a project you created or one you trust?",
  " Claude Code'll be able to read, edit, and execute files here.",
  " Security guide",
];
const NO_SELECTED = screen([...header, " ❯ No, exit", "   Yes, I trust this folder", "", " Enter to confirm · Esc to cancel"]);
const YES_SELECTED = screen([...header, "   No, exit", " ❯ Yes, I trust this folder", "", " Enter to confirm · Esc to cancel"]);
// Earlier builds: "Yes" first and preselected.
const YES_FIRST = screen([
  " Quick safety check",
  " > 1. Yes, I trust this folder",
  "   2. No, exit",
  " Enter to confirm · Esc to cancel",
]);
const LEGACY = screen([
  "Do you trust the files in this folder?",
  "/Users/mathe",
  "❯ 1. Yes, proceed",
  "  2. No, exit",
  "Enter to confirm · Esc to exit",
]);
const REPL = screen(["╭─ Claude Code ─╮", "❯ ", "  ? for shortcuts"]);

// Rendered by the real claude.exe 2.1.283 at 22 and 14 columns: Ink
// word-wraps the option, and at 14 columns the footer too.
const NARROW_22 = screen([
  " Claude Code'll be",
  " able to read, edit,",
  " and execute files",
  " here.",
  "",
  " Security guide",
  "",
  " ❯ No, exit",
  "   Yes, I trust this",
  "   folder",
  "",
  " Enter to confirm ·",
  " Esc to cancel",
]);
const NARROW_14 = screen([
  " Security     ",
  " guide        ",
  "",
  " ❯ No, exit   ",
  "   Yes, I     ",
  "   trust this ",
  "   folder     ",
  " Enter to     ",
  " confirm ·    ",
  " Esc to       ",
  " cancel       ",
]);

describe("parseClaudeFolderTrust", () => {
  it("says which option holds the selection", () => {
    expect(parseClaudeFolderTrust(NO_SELECTED)).toEqual({ selected: "no", yesAbove: false });
    expect(parseClaudeFolderTrust(YES_SELECTED)).toEqual({ selected: "yes", yesAbove: false });
    expect(parseClaudeFolderTrust(YES_FIRST)).toEqual({ selected: "yes", yesAbove: false });
    expect(parseClaudeFolderTrust(LEGACY)).toEqual({ selected: "yes", yesAbove: false });
  });

  it("knows when Yes sits above the selection", () => {
    const noSelectedBelow = screen([
      " Quick safety check",
      "   1. Yes, I trust this folder",
      " ❯ 2. No, exit",
      " Enter to confirm · Esc to cancel",
    ]);
    expect(parseClaudeFolderTrust(noSelectedBelow)).toEqual({ selected: "no", yesAbove: true });
  });

  it("does not mistake a tool approval for the trust dialog", () => {
    expect(
      parseClaudeFolderTrust(
        screen([" Do you want to proceed?", " ❯ 1. Yes, proceed", "   2. No, exit", " Esc to cancel · Tab to amend"]),
      ),
    ).toBeNull();
    expect(parseClaudeFolderTrust(screen(["Yes, I trust this folder"]))).toBeNull();
    expect(parseClaudeFolderTrust(REPL)).toBeNull();
  });

  it("reads the dialog word-wrapped in a narrow pane", () => {
    expect(parseClaudeFolderTrust(NARROW_22)).toEqual({ selected: "no", yesAbove: false });
    expect(parseClaudeFolderTrust(NARROW_14)).toEqual({ selected: "no", yesAbove: false });
    const yes = screen([" ❯ Yes, I trust this", "   folder", "   No, exit", "", " Enter to confirm ·", " Esc to cancel"]);
    expect(parseClaudeFolderTrust(yes)).toEqual({ selected: "yes", yesAbove: false });
  });

  it("reads the older builds' boxed dialog and a wrapped heading", () => {
    const boxed = screen([
      "╭──────────────────────────────────────────╮",
      "│ Do you trust the files in this folder?   │",
      "│                                          │",
      "│ /Users/mathe/proj                        │",
      "│                                          │",
      "│ ❯ 1. Yes, proceed                        │",
      "│   2. No, exit                            │",
      "╰──────────────────────────────────────────╯",
      "   Enter to confirm · Esc to exit",
    ]);
    expect(parseClaudeFolderTrust(boxed)).toEqual({ selected: "yes", yesAbove: false });
    const wrapped = screen(["Do you trust the", "files in this", "folder?", "❯ 1. Yes, proceed", "  2. No, exit", "Enter to confirm"]);
    expect(parseClaudeFolderTrust(wrapped)).toEqual({ selected: "yes", yesAbove: false });
  });

  it("ignores the dialog's words anywhere but in its own live layout", () => {
    // The user's prompt echoed in the transcript quotes both options on one
    // row that starts with ❯ (scratchpad/rev/trust-armed.cjs).
    const RULE = "─".repeat(60);
    const echo = screen([
      "❯ o que muda entre \"No, exit\" e \"Yes, I trust this folder\" no dialog?",
      "",
      "● Na 2.1.283 o dialog mostra \"❯ No, exit\" pré-selecionado.",
      RULE,
      "❯ ",
      RULE,
      "  ⏸ manual mode on · ? for shortcuts",
    ]);
    expect(parseClaudeFolderTrust(echo)).toBeNull();
    // Both options on one row, even with the footer under them.
    expect(parseClaudeFolderTrust(screen([" ❯ No, exit / Yes, I trust this folder", " Enter to confirm"]))).toBeNull();
    // Whole option rows quoted in an answer, above the live REPL.
    const quoted = screen([" ❯ No, exit", "   Yes, I trust this folder", "", RULE, "❯ ", RULE, "  ? for shortcuts"]);
    expect(parseClaudeFolderTrust(quoted)).toBeNull();
    // The options without the dialog's footer under them.
    expect(parseClaudeFolderTrust(screen([" ❯ No, exit", "   Yes, I trust this folder"]))).toBeNull();
  });
});

describe("ClaudeFolderTrustAutoAccept", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function watch(initial: ScreenSnapshot) {
    let current = initial;
    const sent: string[] = [];
    const onAccepted = vi.fn();
    const onGaveUp = vi.fn();
    const watcher = new ClaudeFolderTrustAutoAccept({
      readScreen: () => current,
      send: (keys) => sent.push(keys),
      onAccepted,
      onGaveUp,
    });
    return {
      watcher,
      sent,
      onAccepted,
      onGaveUp,
      show(next: ScreenSnapshot) {
        current = next;
        watcher.check();
      },
    };
  }

  it("moves off the preselected 'No, exit' before confirming", () => {
    // A bare Enter here exits Claude and drops the pane to its shell.
    const trust = watch(NO_SELECTED);
    trust.watcher.check();
    expect(trust.sent).toEqual([CLAUDE_FOLDER_TRUST_DOWN_KEY]);

    trust.show(YES_SELECTED);
    vi.advanceTimersByTime(350);
    expect(trust.sent).toEqual([CLAUDE_FOLDER_TRUST_DOWN_KEY, CLAUDE_FOLDER_TRUST_CONFIRM_KEY]);
    expect(trust.onAccepted).toHaveBeenCalledTimes(1);

    // One shot per spawn.
    trust.show(NO_SELECTED);
    vi.advanceTimersByTime(1000);
    expect(trust.sent).toHaveLength(2);
  });

  it("confirms straight away when 'Yes' is already selected", () => {
    const trust = watch(YES_FIRST);
    trust.watcher.check();
    expect(trust.sent).toEqual([]);
    vi.advanceTimersByTime(350);
    expect(trust.sent).toEqual([CLAUDE_FOLDER_TRUST_CONFIRM_KEY]);
    expect(CLAUDE_FOLDER_TRUST_CONFIRM_KEY).toBe("\r");
  });

  it("moves up when 'Yes' is above the selection", () => {
    const trust = watch(
      screen([" Quick safety check", "   1. Yes, I trust this folder", " ❯ 2. No, exit", " Enter to confirm"]),
    );
    trust.watcher.check();
    expect(trust.sent).toEqual([CLAUDE_FOLDER_TRUST_UP_KEY]);
  });

  it("sends the arrow again when the first one was lost", () => {
    const trust = watch(NO_SELECTED);
    trust.watcher.check();
    // Nothing changed on screen, and no frame comes to say so.
    vi.advanceTimersByTime(400);
    expect(trust.sent).toEqual([CLAUDE_FOLDER_TRUST_DOWN_KEY, CLAUDE_FOLDER_TRUST_DOWN_KEY]);

    trust.show(YES_SELECTED);
    vi.advanceTimersByTime(350);
    expect(trust.sent.at(-1)).toBe(CLAUDE_FOLDER_TRUST_CONFIRM_KEY);
  });

  it("survives Claude snapping the selection back to 'No' right after the first arrow", () => {
    // Captured: "❯ Yes" after the first Down, then "❯ No, exit" again 36 ms
    // later as Claude repaints once raw mode is on.
    const trust = watch(NO_SELECTED);
    trust.watcher.check();
    trust.show(YES_SELECTED);
    vi.advanceTimersByTime(36);
    trust.show(NO_SELECTED);
    vi.advanceTimersByTime(350);
    expect(trust.sent).toEqual([CLAUDE_FOLDER_TRUST_DOWN_KEY, CLAUDE_FOLDER_TRUST_DOWN_KEY]);

    trust.show(YES_SELECTED);
    vi.advanceTimersByTime(350);
    expect(trust.sent).toEqual([
      CLAUDE_FOLDER_TRUST_DOWN_KEY,
      CLAUDE_FOLDER_TRUST_DOWN_KEY,
      CLAUDE_FOLDER_TRUST_CONFIRM_KEY,
    ]);
  });

  it("never confirms over the repaint that snaps the selection back, however late it comes", () => {
    // scratchpad/sweep/live: Claude repaints the dialog once when its
    // terminal queries time out, 98–169 ms after the "Yes" frame over 27 real
    // spawns (claude-bash-18x40 lost the race at 150 ms: Enter on "No, exit").
    for (const repaintMs of [98, 120, 137, 150, 163, 169, 179, 300]) {
      const trust = watch(NO_SELECTED);
      trust.watcher.check();
      vi.advanceTimersByTime(6);
      trust.show(YES_SELECTED);
      vi.advanceTimersByTime(repaintMs);
      expect(trust.sent, `repaint at +${repaintMs} ms`).toEqual([CLAUDE_FOLDER_TRUST_DOWN_KEY]);
      trust.show(NO_SELECTED);
      // The snap-back cancels the pending Enter and moves again right away.
      expect(trust.sent, `repaint at +${repaintMs} ms`).toEqual([
        CLAUDE_FOLDER_TRUST_DOWN_KEY,
        CLAUDE_FOLDER_TRUST_DOWN_KEY,
      ]);
      vi.advanceTimersByTime(6);
      trust.show(YES_SELECTED);
      vi.advanceTimersByTime(349);
      expect(trust.sent).not.toContain(CLAUDE_FOLDER_TRUST_CONFIRM_KEY);
      vi.advanceTimersByTime(1);
      expect(trust.sent.at(-1)).toBe(CLAUDE_FOLDER_TRUST_CONFIRM_KEY);
      expect(trust.onAccepted).toHaveBeenCalledTimes(1);
    }
  });

  it("only confirms once 'Yes' held on a still screen for the whole pause", () => {
    const trust = watch(YES_SELECTED);
    trust.watcher.check();
    vi.advanceTimersByTime(300);
    // Another frame, still on "Yes": the pause starts over.
    trust.show(YES_SELECTED);
    vi.advanceTimersByTime(300);
    expect(trust.sent).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(trust.sent).toEqual([CLAUDE_FOLDER_TRUST_CONFIRM_KEY]);
  });

  it("still confirms a dialog that keeps repainting on 'Yes'", () => {
    const start = Date.now();
    const trust = watch(YES_SELECTED);
    trust.watcher.check();
    for (let elapsed = 0; elapsed < 4000 && trust.sent.length === 0; elapsed += 100) {
      vi.advanceTimersByTime(100);
      trust.show(YES_SELECTED);
    }
    expect(trust.sent).toEqual([CLAUDE_FOLDER_TRUST_CONFIRM_KEY]);
    expect(Date.now() - start).toBeLessThan(2500);
  });

  it("drops a pending Enter when the dialog is mid-repaint, and takes it up again", () => {
    const trust = watch(YES_SELECTED);
    trust.watcher.check();
    vi.advanceTimersByTime(100);
    trust.show(screen([...header, "   No, exit"]));
    vi.advanceTimersByTime(1000);
    expect(trust.sent).toEqual([]);
    trust.show(YES_SELECTED);
    vi.advanceTimersByTime(350);
    expect(trust.sent).toEqual([CLAUDE_FOLDER_TRUST_CONFIRM_KEY]);
  });

  it("gives up after a bounded number of moves and never confirms 'No'", () => {
    const trust = watch(NO_SELECTED);
    trust.watcher.check();
    vi.advanceTimersByTime(5000);
    expect(trust.sent.filter((key) => key === CLAUDE_FOLDER_TRUST_DOWN_KEY)).toHaveLength(5);
    expect(trust.sent).not.toContain(CLAUDE_FOLDER_TRUST_CONFIRM_KEY);
    expect(trust.onGaveUp).toHaveBeenCalledTimes(1);
  });

  it("does not confirm when the selection moved away during the pause", () => {
    const trust = watch(YES_SELECTED);
    trust.watcher.check();
    trust.show(NO_SELECTED);
    vi.advanceTimersByTime(350);
    expect(trust.sent).not.toContain(CLAUDE_FOLDER_TRUST_CONFIRM_KEY);
  });

  it("does nothing on other screens, or once stopped", () => {
    const trust = watch(REPL);
    trust.watcher.check();
    vi.advanceTimersByTime(1000);
    expect(trust.sent).toEqual([]);

    const stopped = watch(NO_SELECTED);
    stopped.watcher.stop();
    stopped.watcher.check();
    expect(stopped.sent).toEqual([]);
  });

  it("answers the dialog in a narrow pane", () => {
    const trust = watch(NARROW_22);
    trust.watcher.check();
    expect(trust.sent).toEqual([CLAUDE_FOLDER_TRUST_DOWN_KEY]);
    trust.show(screen([" ❯ Yes, I trust this", "   folder", "   No, exit", "", " Enter to confirm ·", " Esc to cancel"]));
    vi.advanceTimersByTime(350);
    expect(trust.sent.at(-1)).toBe(CLAUDE_FOLDER_TRUST_CONFIRM_KEY);
  });

  it("never types into the live REPL, whatever the transcript quotes", () => {
    // scratchpad/rev/trust-armed.cjs: no Claude title all session, an
    // already-trusted folder, and the user's prompt quoting both options.
    const RULE = "─".repeat(60);
    const trust = watch(REPL);
    trust.show(
      screen([
        "❯ o que muda entre \"No, exit\" e \"Yes, I trust this folder\" no dialog?",
        RULE,
        "❯ ",
        RULE,
        "  ⏸ manual mode on · ? for shortcuts",
      ]),
    );
    vi.advanceTimersByTime(2000);
    expect(trust.sent).toEqual([]);
  });

  it("stands down for good once the REPL is up", () => {
    let current = REPL;
    const sent: string[] = [];
    const watcher = new ClaudeFolderTrustAutoAccept({
      readScreen: () => current,
      send: (keys) => sent.push(keys),
      isAgentUp: (snapshot) => snapshot === REPL,
    });
    watcher.check();
    // Even a trust dialog drawn later (never happens) is left alone.
    current = NO_SELECTED;
    watcher.check();
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
  });

  it("still answers after a restart over the dead REPL's screen", () => {
    // scratchpad/rev5/restart-sim.cjs: the reused xterm still shows the old
    // REPL when the new spawn's first frame ("\x1b[?9001h\x1b[?1004h") comes,
    // ~700 ms before it paints. Read raw, that screen is "the agent is up" and
    // the watch stood down for good: "No, exit" stayed selected.
    let lines = [...REPL.rows, "", "── sessão reiniciada (tentativa 2) ──"];
    const xterm: ScreenSource = {
      get rows() {
        return lines.length;
      },
      buffer: {
        active: {
          type: "normal",
          baseY: 0,
          cursorX: 0,
          cursorY: 0,
          getLine: (y: number) =>
            lines[y] === undefined ? undefined : { translateToString: () => lines[y] },
        },
      },
    };
    const spawnScreen = new SpawnScreenReader(xterm);
    spawnScreen.holdUntilPainted();
    const sent: string[] = [];
    const watcher = new ClaudeFolderTrustAutoAccept({
      readScreen: spawnScreen.read,
      send: (keys) => sent.push(keys),
      isAgentUp: (snapshot) => {
        const state = classifyClaudeScreen(snapshot).state;
        return state === "idle" || state === "working";
      },
    });
    const frame = (text: string) => {
      spawnScreen.noteFrame(text);
      watcher.check();
    };
    frame("\x1b[?9001h\x1b[?1004h");
    vi.advanceTimersByTime(700);
    lines = NO_SELECTED.rows;
    frame("\x1b[?25l\x1b[2J\x1b[m\x1b[H Accessing workspace:");
    expect(sent).toEqual([CLAUDE_FOLDER_TRUST_DOWN_KEY]);
    lines = YES_SELECTED.rows;
    frame(" ❯ Yes, I trust this folder");
    vi.advanceTimersByTime(350);
    expect(sent).toEqual([CLAUDE_FOLDER_TRUST_DOWN_KEY, CLAUDE_FOLDER_TRUST_CONFIRM_KEY]);
  });

  it("stands down once its startup window is over", () => {
    const trust = watch(screen([" Loading…"]));
    trust.watcher.check();
    vi.advanceTimersByTime(31_000);
    trust.show(NO_SELECTED);
    vi.advanceTimersByTime(1000);
    expect(trust.sent).toEqual([]);

    // Inside the window it still answers.
    const early = watch(screen([" Loading…"]));
    early.watcher.check();
    vi.advanceTimersByTime(20_000);
    early.show(NO_SELECTED);
    expect(early.sent).toEqual([CLAUDE_FOLDER_TRUST_DOWN_KEY]);
  });

  it("cancels a pending confirm on dispose", () => {
    const trust = watch(YES_SELECTED);
    trust.watcher.check();
    trust.watcher.dispose();
    trust.watcher.stop();
    vi.advanceTimersByTime(200);
    expect(trust.sent).toEqual([]);
  });
});
