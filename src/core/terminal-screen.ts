import type { Terminal } from "@xterm/xterm";

/**
 * What a pane shows right now, as plain text. The status engine reads the
 * rendered screen instead of the PTY byte stream: ConPTY re-renders by cell
 * diff (spaces become cursor moves, unchanged cells are skipped), so a phrase
 * the agent painted once may never appear contiguously in the bytes again —
 * while xterm's buffer always holds the whole, correct text.
 */
export interface ScreenSnapshot {
  /** The live screen's rows up to the last painted one, top to bottom,
   * right-trimmed. The live screen, not the user's scroll position:
   * scrolling back to read old output must not change what the agent is
   * doing. */
  rows: string[];
  /** The cursor's line up to the cursor column — where a shell prompt ends.
   * The whole line when it wrapped: a prompt with a long path in a narrow
   * pane starts rows above the cursor ("PS C:\…\proj> echo li" / "ne-two"). */
  cursorLine: string;
  /** A full-screen program owns the alternate buffer. */
  altScreen: boolean;
}

export const EMPTY_SCREEN: ScreenSnapshot = { rows: [], cursorLine: "", altScreen: false };

/** Dialogs, prompts and spinners all live at the bottom of what an agent
 * drew; thirty rows cover the tallest permission dialog and keep a read cheap
 * enough to run several times a second per pane. */
export const SCREEN_SNAPSHOT_ROWS = 30;

/** The slice of xterm this needs — @xterm/headless fits it too, which is how
 * the recorded agent sessions are replayed through the detector offline. */
export type ScreenSource = {
  rows: number;
  buffer: {
    active: {
      type: string;
      baseY: number;
      cursorX: number;
      cursorY: number;
      getLine(y: number):
        | {
            /** The row continues the one above it (xterm wrapped the line). */
            isWrapped?: boolean;
            translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
          }
        | undefined;
    };
  };
};

/** Rows a wrapped cursor line is followed up through: a prompt with a long
 * path in a pane a few dozen columns wide. */
const CURSOR_LINE_MAX_ROWS = 12;

export function readTerminalScreen(
  terminal: ScreenSource | Terminal,
  maxRows = SCREEN_SNAPSHOT_ROWS,
): ScreenSnapshot {
  const buffer = terminal.buffer.active;
  const height = terminal.rows;
  const top = buffer.baseY;
  const bottom = buffer.baseY + height - 1;
  const text = (y: number) => buffer.getLine(y)?.translateToString(true) ?? "";

  // The window ends at the last row anything was painted on, not at the
  // bottom of the viewport: an inline TUI in a fresh terminal (Claude's
  // workspace trust, codex, cursor-agent) draws from the top and leaves the
  // rest blank — in a tall pane its dialog sits far above the last thirty
  // rows. Nor at the cursor: codex parks it at the bottom, under blank rows.
  let last = bottom;
  while (last > top && !text(last).trim()) {
    last -= 1;
  }
  const first = Math.max(top, last - maxRows + 1);
  const rows: string[] = [];
  for (let y = first; y <= last; y += 1) {
    rows.push(text(y));
  }
  let y = buffer.baseY + buffer.cursorY;
  let row = buffer.getLine(y);
  let cursorLine = row?.translateToString(false, 0, buffer.cursorX) ?? "";
  for (let rowsUp = 1; row?.isWrapped && y > 0 && rowsUp < CURSOR_LINE_MAX_ROWS; rowsUp += 1) {
    y -= 1;
    row = buffer.getLine(y);
    cursorLine = (row?.translateToString(false) ?? "") + cursorLine;
  }
  return { rows, cursorLine, altScreen: buffer.type === "alternate" };
}

/** Escape sequences, printing nothing: CSI, OSC (even one a frame cut in
 * half), DCS/SOS/PM/APC strings and the two-byte escapes. */
const CONTROL_SEQUENCE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)|\x1b[PX^_][\s\S]*?(?:\x1b\\|$)|\x1b[\s\S]?/gu;
const SCREEN_CLEAR = /\x1b\[[23]J/u;
const PRINTABLE = /[^\x00-\x1f\x7f]/u;

/** A frame that draws on the screen: a clear (ConPTY opens every spawn's
 * first paint with "\x1b[2J"), or any printable text (a POSIX pty clears
 * nothing, the new process just writes). Mode switches and titles do not. */
export function paintsScreen(frameText: string): boolean {
  return SCREEN_CLEAR.test(frameText) || PRINTABLE.test(frameText.replace(CONTROL_SEQUENCE, ""));
}

/**
 * The screen as the pane's current process drew it. A restart keeps the
 * pane's xterm, so until the new process paints, what xterm shows is the
 * previous one's screen — a dead Claude's REPL box and "? for shortcuts",
 * which read as "the agent is up". ConPTY's first chunk only switches modes
 * ("\x1b[?9001h\x1b[?1004h") and its "\x1b[2J" repaint comes ~700 ms later.
 * Until the new process paints, this reads as an empty screen, for every
 * consumer alike (the status engine and the folder-trust auto-accept).
 */
export class SpawnScreenReader {
  private stale = false;

  constructor(private readonly terminal: ScreenSource | Terminal) {}

  /** The next process spawns over a previous one's screen. */
  holdUntilPainted(): void {
    this.stale = true;
  }

  /** xterm parsed a frame of the current process's output. */
  noteFrame(frameText: string): void {
    if (this.stale && paintsScreen(frameText)) {
      this.stale = false;
    }
  }

  readonly read = (): ScreenSnapshot =>
    this.stale ? EMPTY_SCREEN : readTerminalScreen(this.terminal);
}

// Box-drawn dialogs (cursor-agent's trust, older Claude builds): a phrase
// wrapped inside the box reads whole once the side edges are gone and every
// space is dropped.
const BOX_EDGE_LEFT = /^(\s*)[│┃║]/u;
const BOX_EDGE_RIGHT = /\s*[│┃║]\s*$/u;

/** A row without a box's side edges, its indentation kept. */
export function unboxRow(row: string): string {
  return row.replace(BOX_EDGE_RIGHT, "").replace(BOX_EDGE_LEFT, "$1 ");
}

/** A row lower-cased with every whitespace removed. */
export function compactRow(row: string): string {
  return row.toLowerCase().replace(/\s+/gu, "");
}
