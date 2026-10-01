import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import { buildPalette, readRemoteScreen } from "./remote-screen";

interface FakeCell {
  char: string;
  width?: number;
  fg?: number;
  fgRgb?: boolean;
  bold?: boolean;
  inverse?: boolean;
}

function cellApi(cell: FakeCell) {
  const palette = cell.fg !== undefined && !cell.fgRgb;
  return {
    getChars: () => cell.char,
    getWidth: () => cell.width ?? 1,
    isFgRGB: () => Boolean(cell.fgRgb),
    isFgPalette: () => palette,
    getFgColor: () => cell.fg ?? 0,
    isBgRGB: () => false,
    isBgPalette: () => false,
    getBgColor: () => 0,
    isInverse: () => (cell.inverse ? 1 : 0),
    isInvisible: () => 0,
    isBold: () => (cell.bold ? 1 : 0),
    isDim: () => 0,
    isItalic: () => 0,
    isUnderline: () => 0,
    isStrikethrough: () => 0,
  };
}

/** Rows of plain text, padded to `cols`; `styled` overrides single cells. */
function fakeTerminal(
  rows: Array<{ text: string; wrapped?: boolean; styled?: Record<number, Partial<FakeCell>> }>,
  options: { cols?: number; cursor?: [number, number] } = {},
): Terminal {
  const cols = options.cols ?? 10;
  const lines = rows.map((row) => {
    const cells: FakeCell[] = Array.from({ length: cols }, (_, x) => ({
      char: row.text[x] ?? "",
      ...row.styled?.[x],
    }));
    return {
      isWrapped: Boolean(row.wrapped),
      length: cols,
      getCell: (x: number) => cellApi(cells[x]),
    };
  });
  const [cursorX, cursorY] = options.cursor ?? [0, rows.length - 1];
  return {
    cols,
    rows: rows.length,
    options: { theme: { foreground: "#eeeeee", background: "#111111", red: "#ff0000" } },
    buffer: {
      active: {
        length: lines.length,
        baseY: 0,
        cursorX,
        cursorY,
        getLine: (y: number) => lines[y],
      },
    },
  } as unknown as Terminal;
}

function text(screen: ReturnType<typeof readRemoteScreen>): string[] {
  return screen.lines.map((runs) => runs.map(([chars]) => chars).join(""));
}

describe("buildPalette", () => {
  it("has the theme's 16 colors, the cube and the gray ramp", () => {
    const palette = buildPalette({ red: "#ff0000" });
    expect(palette).toHaveLength(256);
    expect(palette[1]).toBe("#ff0000");
    expect(palette[16]).toBe("#000000");
    expect(palette[231]).toBe("#ffffff");
    expect(palette[232]).toBe("#080808");
  });
});

describe("readRemoteScreen", () => {
  it("reads the text, trimmed, and drops the empty bottom of the screen", () => {
    const screen = readRemoteScreen(
      "pane",
      fakeTerminal([{ text: "hello" }, { text: "$ " }, { text: "" }, { text: "" }], {
        cursor: [2, 1],
      }),
      42,
    );
    expect(text(screen)).toEqual(["hello", "$"]);
    expect(screen.cursor).toEqual({ line: 1, col: 2 });
    expect(screen).toMatchObject({ paneId: "pane", cols: 10, rows: 4, at: 42 });
    expect(screen.theme).toEqual({ background: "#111111", foreground: "#eeeeee" });
  });

  it("joins wrapped rows back into one line", () => {
    const screen = readRemoteScreen(
      "pane",
      fakeTerminal(
        [{ text: "abcdefghij" }, { text: "klm", wrapped: true }, { text: "next" }],
        { cursor: [1, 1] },
      ),
    );
    expect(text(screen)).toEqual(["abcdefghijklm", "next"]);
    expect(screen.cursor).toEqual({ line: 0, col: 11 });
  });

  it("resolves colors into a style table, default first", () => {
    const screen = readRemoteScreen(
      "pane",
      fakeTerminal([
        {
          text: "ok err",
          styled: { 3: { fg: 1, bold: true }, 4: { fg: 1, bold: true }, 5: { fg: 1, bold: true } },
        },
      ]),
    );
    expect(screen.styles[0]).toBe("");
    expect(screen.lines[0]).toEqual([
      ["ok ", 0],
      ["err", 1],
    ]);
    expect(screen.styles[1]).toBe("color:#ff0000;font-weight:700");
  });

  it("swaps the theme's colors for inverse video", () => {
    const screen = readRemoteScreen(
      "pane",
      fakeTerminal([{ text: "> yes", styled: { 0: { inverse: true } } }]),
    );
    expect(screen.styles[screen.lines[0][0][1]]).toBe("color:#111111;background:#eeeeee");
  });

  it("skips the second half of a wide character", () => {
    const screen = readRemoteScreen(
      "pane",
      fakeTerminal([{ text: "界 a", styled: { 1: { char: "", width: 0 } } }]),
    );
    expect(text(screen)).toEqual(["界a"]);
  });
});
