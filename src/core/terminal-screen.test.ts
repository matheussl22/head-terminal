import { describe, expect, it } from "vitest";

import {
  EMPTY_SCREEN,
  paintsScreen,
  readTerminalScreen,
  SpawnScreenReader,
  type ScreenSource,
} from "./terminal-screen";

/** A buffer of `lines`, `rows` tall, scrolled so its last `rows` lines are
 * the live screen. */
function fakeTerminal(lines: string[], rows: number, cursor: { x: number; y: number }, type = "normal"): ScreenSource {
  const baseY = Math.max(0, lines.length - rows);
  return {
    rows,
    buffer: {
      active: {
        type,
        baseY,
        cursorX: cursor.x,
        cursorY: cursor.y,
        getLine: (y: number) => {
          const text = lines[y];
          if (text === undefined) {
            return undefined;
          }
          return {
            translateToString: (trimRight?: boolean, start = 0, end?: number) => {
              const padded = text.padEnd(20, " ").slice(start, end);
              return trimRight ? padded.replace(/\s+$/u, "") : padded;
            },
          };
        },
      },
    },
  };
}

describe("readTerminalScreen", () => {
  it("reads the live screen's bottom rows, whatever the user scrolled to", () => {
    const lines = ["old 1", "old 2", "row A", "row B", "PS C:\\> ls"];
    const snapshot = readTerminalScreen(fakeTerminal(lines, 3, { x: 8, y: 2 }), 30);
    expect(snapshot).toEqual({
      rows: ["row A", "row B", "PS C:\\> ls"],
      cursorLine: "PS C:\\> ",
      altScreen: false,
    });
  });

  it("keeps only the last rows asked for", () => {
    const lines = ["a", "b", "c", "d"];
    expect(readTerminalScreen(fakeTerminal(lines, 4, { x: 0, y: 3 }), 2).rows).toEqual(["c", "d"]);
  });

  // Measured in the real app: a 57-row pane, baseY 0, Claude's workspace
  // trust drawn on rows 2–16 of a fresh terminal and nothing below — the
  // bottom 30 rows were all blank, so the dialog was never recognized.
  const TRUST_DIALOG = [
    " Accessing workspace:",
    "",
    " C:\\Users\\mathe\\proj",
    "",
    " Quick safety check: Is this a project you created or one you trust?",
    "",
    " Claude Code'll be able to read, edit, and execute files here.",
    "",
    " Security guide",
    "",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    "",
    " Enter to confirm · Esc to cancel",
    "",
  ];

  it("reads an inline TUI drawn at the top of a tall, fresh pane", () => {
    const lines = ["", "", ...TRUST_DIALOG, ...Array<string>(40).fill("")];
    expect(lines).toHaveLength(57);
    const snapshot = readTerminalScreen(fakeTerminal(lines, 57, { x: 33, y: 15 }), 30);
    const painted = snapshot.rows.filter((row) => row.trim());
    expect(painted.at(-1)).toBe(" Enter to confirm · Esc to cancel");
    expect(painted).toContain(" ❯ No, exit");
    expect(painted).toContain("   Yes, I trust this folder");
    expect(painted[0]).toBe(" Accessing workspace:");
    expect(snapshot.cursorLine).toBe(" Enter to confirm · Esc to cancel");
  });

  it("anchors on the last painted row, not on a cursor parked at the bottom", () => {
    // codex: its UI on rows 0–8, the cursor left on row 56.
    const codex = [
      "  Do you trust the contents of this directory?",
      "",
      "› 1. Yes, continue",
      "  2. No, quit",
      "",
      "  Press enter to continue",
    ];
    const lines = [...codex, ...Array<string>(51).fill("")];
    const snapshot = readTerminalScreen(fakeTerminal(lines, 57, { x: 0, y: 56 }), 30);
    expect(snapshot.rows).toEqual(codex);
    expect(snapshot.cursorLine).toBe("");
  });

  it("still takes only the last rows of a screen painted all the way down", () => {
    const lines = Array.from({ length: 57 }, (_, index) => `row ${index}`);
    lines[56] = "";
    lines[55] = "";
    const rows = readTerminalScreen(fakeTerminal(lines, 57, { x: 0, y: 56 }), 30).rows;
    expect(rows).toHaveLength(30);
    expect(rows[0]).toBe("row 25");
    expect(rows.at(-1)).toBe("row 54");
  });

  it("never reaches into the scrollback above the live screen", () => {
    // The live screen is the last 5 lines; only its first row is painted.
    const lines = ["old 1", "old 2", "old 3", "live top", "", "", "", ""];
    const snapshot = readTerminalScreen(fakeTerminal(lines, 5, { x: 0, y: 0 }), 30);
    expect(snapshot.rows).toEqual(["live top"]);
  });

  it("reads the cursor's line whole when it wrapped", () => {
    // fin/e2e T7: in a 148-column pane the prompt's long path wraps, and the
    // cursor row alone ("ne-two") says nothing about the prompt before it.
    const width = 20;
    const rows = ["line-one", "PS C:\\work\\proj> ech", "o line-two"];
    const wrapped = [false, false, true];
    const terminal: ScreenSource = {
      rows: 3,
      buffer: {
        active: {
          type: "normal",
          baseY: 0,
          cursorX: 10,
          cursorY: 2,
          getLine: (y: number) => ({
            isWrapped: wrapped[y],
            translateToString: (trimRight?: boolean, start = 0, end?: number) => {
              const padded = rows[y].padEnd(width, " ").slice(start, end);
              return trimRight ? padded.replace(/\s+$/u, "") : padded;
            },
          }),
        },
      },
    };
    expect(readTerminalScreen(terminal).cursorLine).toBe("PS C:\\work\\proj> echo line-two");
    expect(readTerminalScreen(terminal).rows).toEqual(rows);
  });

  it("knows when a full-screen program owns the alternate buffer", () => {
    const snapshot = readTerminalScreen(fakeTerminal(["x"], 1, { x: 0, y: 0 }, "alternate"));
    expect(snapshot.altScreen).toBe(true);
  });
});

describe("SpawnScreenReader", () => {
  // A restart reuses the pane's xterm: the dead Claude's REPL is still up.
  const OLD_REPL = ["─".repeat(20), "❯ ", "─".repeat(20), "  ? for shortcuts", "", "── sessão reiniciada ──"];

  it("reads a first spawn's screen straight away", () => {
    const reader = new SpawnScreenReader(fakeTerminal(["PS C:\\> "], 1, { x: 8, y: 0 }));
    expect(reader.read().cursorLine).toBe("PS C:\\> ");
  });

  it("shows nothing of the previous process until the new one paints over a clear", () => {
    // ConPTY: modes first, the title, and only ~700 ms later the "\x1b[2J".
    const reader = new SpawnScreenReader(fakeTerminal(OLD_REPL, 6, { x: 0, y: 5 }));
    reader.holdUntilPainted();
    expect(reader.read()).toEqual(EMPTY_SCREEN);
    reader.noteFrame("\x1b[?9001h\x1b[?1004h");
    reader.noteFrame("\x1b]0;C:\\Program Files\\PowerShell\\7\\pwsh.exe\x07");
    reader.noteFrame("\x1b[?25h\x1b[?2004h");
    expect(reader.read()).toEqual(EMPTY_SCREEN);
    reader.noteFrame("\x1b[?25l\x1b[2J\x1b[m\x1b[H");
    expect(reader.read().rows).toEqual(OLD_REPL.map((row) => row.trimEnd()));
  });

  it("goes live on the new process's first text where nothing clears (POSIX)", () => {
    const reader = new SpawnScreenReader(fakeTerminal(OLD_REPL, 6, { x: 0, y: 5 }));
    reader.holdUntilPainted();
    reader.noteFrame("\x1b[?2004h\r\n");
    expect(reader.read()).toEqual(EMPTY_SCREEN);
    reader.noteFrame("\x1b[1;32m➜\x1b[0m  proj ");
    expect(reader.read().rows).toEqual(OLD_REPL.map((row) => row.trimEnd()));
  });
});

describe("paintsScreen", () => {
  it("tells a paint from mode switches, titles and bare line breaks", () => {
    expect(paintsScreen("\x1b[?9001h\x1b[?1004h")).toBe(false);
    expect(paintsScreen("\x1b]0;claude\x07\x1b[?25l")).toBe(false);
    expect(paintsScreen("\x1b]2;half a tit")).toBe(false);
    expect(paintsScreen("\r\n")).toBe(false);
    expect(paintsScreen("\x1b[3J")).toBe(true);
    expect(paintsScreen("\x1b[H\x1b[2J")).toBe(true);
    expect(paintsScreen("\x1b[31m$ \x1b[0m")).toBe(true);
  });
});
