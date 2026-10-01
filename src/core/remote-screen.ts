import type { IBufferCell, IDisposable, ITheme, Terminal } from "@xterm/xterm";

import type { RemoteRun, RemoteScreen } from "../types/remote";

/**
 * A pane's terminal as the phone draws it: the tail of the buffer, resolved
 * to colors, with wrapped rows joined back into the logical lines the
 * program printed — the phone wraps them again at its own width.
 */

/** Terminals whose program hid the cursor (DECTCEM, `CSI ?25l`), as the
 * agent TUIs do: the phone draws no cursor for them. xterm keeps that state
 * private, so it is followed from the parser. */
const hiddenCursor = new WeakSet<Terminal>();

export function trackCursorVisibility(terminal: Terminal): IDisposable {
  const note = (hidden: boolean) => (params: (number | number[])[]) => {
    if (params.includes(25)) {
      if (hidden) hiddenCursor.add(terminal);
      else hiddenCursor.delete(terminal);
    }
    // Only watching: xterm still applies the mode itself.
    return false;
  };
  const show = terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, note(false));
  const hide = terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, note(true));
  return {
    dispose: () => {
      show.dispose();
      hide.dispose();
    },
  };
}

/** Rows read from the bottom of the buffer. */
export const REMOTE_SCREEN_ROWS = 240;

const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** xterm's own defaults, for a theme that leaves a color out. */
const ANSI_DEFAULTS = [
  "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
];

function hex(value: number): string {
  return `#${value.toString(16).padStart(6, "0")}`;
}

/** The 256-color palette: the theme's 16, the 6×6×6 cube, the gray ramp. */
export function buildPalette(theme: ITheme | undefined): string[] {
  const palette: string[] = ANSI_NAMES.map(
    (name, index) => (theme?.[name] as string | undefined) ?? ANSI_DEFAULTS[index],
  );
  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r += 1) {
    for (let g = 0; g < 6; g += 1) {
      for (let b = 0; b < 6; b += 1) {
        palette.push(hex((steps[r] << 16) | (steps[g] << 8) | steps[b]));
      }
    }
  }
  for (let index = 0; index < 24; index += 1) {
    const level = 8 + index * 10;
    palette.push(hex((level << 16) | (level << 8) | level));
  }
  return palette;
}

interface Colors {
  palette: string[];
  foreground: string;
  background: string;
}

function fgOf(cell: IBufferCell, colors: Colors): string | null {
  if (cell.isFgRGB()) return hex(cell.getFgColor());
  if (cell.isFgPalette()) return colors.palette[cell.getFgColor()] ?? null;
  return null;
}

function bgOf(cell: IBufferCell, colors: Colors): string | null {
  if (cell.isBgRGB()) return hex(cell.getBgColor());
  if (cell.isBgPalette()) return colors.palette[cell.getBgColor()] ?? null;
  return null;
}

/** CSS for one cell's attributes; "" is the default look. */
function styleOf(cell: IBufferCell, colors: Colors): string {
  let fg = fgOf(cell, colors);
  let bg = bgOf(cell, colors);
  if (cell.isInverse()) {
    [fg, bg] = [bg ?? colors.background, fg ?? colors.foreground];
  }
  const parts: string[] = [];
  if (cell.isInvisible()) parts.push("color:transparent");
  else if (fg) parts.push(`color:${fg}`);
  if (bg) parts.push(`background:${bg}`);
  if (cell.isBold()) parts.push("font-weight:700");
  if (cell.isDim()) parts.push("opacity:.6");
  if (cell.isItalic()) parts.push("font-style:italic");
  const decorations = [
    cell.isUnderline() ? "underline" : "",
    cell.isStrikethrough() ? "line-through" : "",
  ].filter(Boolean);
  if (decorations.length > 0) parts.push(`text-decoration:${decorations.join(" ")}`);
  return parts.join(";");
}

/** Drops trailing blank runs in the default look (padding, not content). */
function trimLine(runs: RemoteRun[]): RemoteRun[] {
  while (runs.length > 0) {
    const last = runs[runs.length - 1];
    if (last[1] !== 0) break;
    const trimmed = last[0].replace(/\s+$/u, "");
    if (trimmed) {
      last[0] = trimmed;
      break;
    }
    runs.pop();
  }
  return runs;
}

export function readRemoteScreen(
  paneId: string,
  terminal: Terminal,
  now = Date.now(),
): RemoteScreen {
  const theme = terminal.options.theme;
  const colors: Colors = {
    palette: buildPalette(theme),
    foreground: theme?.foreground ?? "#e6e7ea",
    background: theme?.background ?? "#0b0c0e",
  };
  const buffer = terminal.buffer.active;
  const styles: string[] = [""];
  const styleIndex = new Map<string, number>([["", 0]]);
  const lines: RemoteRun[][] = [];
  const cursorRow = buffer.baseY + buffer.cursorY;
  let cursor: RemoteScreen["cursor"];
  let cell: IBufferCell | undefined;
  // Columns of the logical line already filled by the rows wrapped into it.
  let lineOffset = 0;

  const start = Math.max(0, buffer.length - REMOTE_SCREEN_ROWS);
  for (let row = start; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const joins = line.isWrapped && lines.length > 0;
    const runs: RemoteRun[] = joins ? lines[lines.length - 1] : [];
    if (!joins) lineOffset = 0;
    if (row === cursorRow && !hiddenCursor.has(terminal)) {
      cursor = { line: joins ? lines.length - 1 : lines.length, col: lineOffset + buffer.cursorX };
    }
    for (let x = 0; x < line.length; x += 1) {
      cell = line.getCell(x, cell);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      const css = styleOf(cell, colors);
      let index = styleIndex.get(css);
      if (index === undefined) {
        index = styles.length;
        styles.push(css);
        styleIndex.set(css, index);
      }
      const last = runs[runs.length - 1];
      if (last && last[1] === index) last[0] += chars;
      else runs.push([chars, index]);
    }
    lineOffset += line.length;
    if (!joins) lines.push(runs);
  }

  // Rows past the cursor that nothing was written to are the screen's empty
  // bottom, not output: the phone scrolls to what was printed last.
  for (const runs of lines) trimLine(runs);
  const lastWithText = lines.reduce((last, runs, index) => (runs.length > 0 ? index : last), -1);
  const keep = Math.max(lastWithText, cursor?.line ?? -1) + 1;
  lines.length = Math.min(lines.length, keep);

  return {
    paneId,
    cols: terminal.cols,
    rows: terminal.rows,
    lines,
    styles,
    cursor,
    theme: { background: colors.background, foreground: colors.foreground },
    at: now,
  };
}
