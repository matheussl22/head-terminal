import type { ITerminalOptions, ITheme } from "@xterm/xterm";

import { loadFontSize } from "../core/ui-preferences";
import { getCachedPlatformInfo } from "../core/platform-info";

// Graphite terminal: near-black ground, soft white text, amber cursor. ANSI
// colors are tuned to read on #0b0c0e without going neon — the chrome around
// the terminal is deliberately quiet, so the terminal's own colors carry the
// information.
export const HYPER_THEME = {
  fontFamily:
    'Menlo, "Cascadia Mono", "DejaVu Sans Mono", Consolas, "Lucida Console", monospace',
  fontSize: 12,
  lineHeight: 1,
  letterSpacing: 0,
  foreground: "#e6e7ea",
  background: "#0b0c0e",
  cursor: "rgba(240, 168, 50, 0.9)",
  cursorAccent: "#0b0c0e",
  selection: "rgba(240, 168, 50, 0.28)",
  accent: "#f0a832",
  accentMuted: "rgba(240, 168, 50, 0.45)",
  enabled: "#3fb950",
  enabledMuted: "rgba(63, 185, 80, 0.2)",
  terminalPadding: "10px 12px",
  colors: {
    black: "#1b1e23",
    red: "#ff6b6b",
    green: "#56d364",
    yellow: "#e3b341",
    blue: "#58a6ff",
    magenta: "#d98cd6",
    cyan: "#56d4dd",
    white: "#d6d9de",
    lightBlack: "#7d838c",
    lightRed: "#ff8e8a",
    lightGreen: "#7ee787",
    lightYellow: "#f2cc60",
    lightBlue: "#79c0ff",
    lightMagenta: "#e8a9e5",
    lightCyan: "#8ae6ee",
    lightWhite: "#ffffff",
    limeGreen: "#56d364",
    lightCoral: "#ff8e8a",
  },
} as const;

export const HEAD_THEME = {
  background: HYPER_THEME.background,
  foreground: HYPER_THEME.foreground,
  cursor: HYPER_THEME.cursor,
  header: "#15171b",
  border: "#2a2d33",
  buttonBg: "#1b1e23",
  buttonBorder: "#2a2d33",
  buttonHover: "#22262c",
  fontFamily: HYPER_THEME.fontFamily,
  fontSize: HYPER_THEME.fontSize,
} as const;

function createXtermTheme(): ITheme {
  const { colors } = HYPER_THEME;

  return {
    background: HYPER_THEME.background,
    foreground: HYPER_THEME.foreground,
    cursor: HYPER_THEME.cursor,
    cursorAccent: HYPER_THEME.cursorAccent,
    selectionBackground: HYPER_THEME.selection,
    black: colors.black,
    red: colors.red,
    green: colors.green,
    yellow: colors.yellow,
    blue: colors.blue,
    magenta: colors.magenta,
    cyan: colors.cyan,
    white: colors.white,
    brightBlack: colors.lightBlack,
    brightRed: colors.lightRed,
    brightGreen: colors.lightGreen,
    brightYellow: colors.lightYellow,
    brightBlue: colors.lightBlue,
    brightMagenta: colors.lightMagenta,
    brightCyan: colors.lightCyan,
    brightWhite: colors.lightWhite,
  };
}

/**
 * Every Windows pane runs on ConPTY (node-pty). Without this, ConPTY's own
 * screen reflow on redraw/resize disagrees with xterm.js's line-wrap tracking
 * and full-screen redraws (Claude Code's Ink UI) come out with stray
 * duplicated fragments. `undefined` (non-Windows, or platform info not fetched
 * yet) leaves xterm.js on its default heuristics.
 */
function resolveWindowsPty(): ITerminalOptions["windowsPty"] {
  const info = getCachedPlatformInfo();
  if (!info || info.platform !== "win32" || info.windowsBuild === undefined) {
    return undefined;
  }
  // node-pty defaults to the ConPTY backend on any Windows build recent
  // enough to have one (>=1809), which covers every build worth supporting.
  return { backend: "conpty", buildNumber: info.windowsBuild };
}

export function createTerminalOptions(): ITerminalOptions {
  return {
    convertEol: true,
    cursorBlink: false,
    cursorStyle: "block",
    fontSize: loadFontSize(),
    fontFamily: HYPER_THEME.fontFamily,
    lineHeight: HYPER_THEME.lineHeight,
    letterSpacing: HYPER_THEME.letterSpacing,
    drawBoldTextInBrightColors: true,
    // Lift near-black ANSI colors so they never vanish on #000.
    minimumContrastRatio: 4.5,
    theme: createXtermTheme(),
    windowsPty: resolveWindowsPty(),
  };
}
