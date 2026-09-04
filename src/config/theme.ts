import type { ITerminalOptions, ITheme } from "@xterm/xterm";

import { loadFontSize } from "../core/ui-preferences";
import { getCachedPlatformInfo } from "../core/platform-info";

// Hyper-inspired, but with ANSI colors that actually read on pure black.
// (Stock Hyper blue #0A2FC4 is nearly invisible on #000.)
export const HYPER_THEME = {
  fontFamily:
    'Menlo, "DejaVu Sans Mono", Consolas, "Lucida Console", monospace',
  fontSize: 12,
  lineHeight: 1,
  letterSpacing: 0,
  // Slightly soft default fg so bright ANSI (green/cyan/magenta) pops more
  // than body text — avoids the "everything is flat white" feel.
  foreground: "#E8E8EC",
  background: "#000000",
  cursor: "rgba(248, 28, 229, 0.85)",
  cursorAccent: "#000000",
  selection: "rgba(248, 28, 229, 0.32)",
  accent: "#f81ce5",
  accentMuted: "rgba(248, 28, 229, 0.35)",
  enabled: "#67f86f",
  enabledMuted: "rgba(103, 248, 111, 0.2)",
  terminalPadding: "12px 14px",
  colors: {
    black: "#0C0C0C",
    red: "#FF6B6B",
    green: "#5AF78E",
    yellow: "#F3F99D",
    blue: "#6A76FB",
    magenta: "#FF6AC1",
    cyan: "#6AE4FF",
    white: "#F1F1F0",
    lightBlack: "#7A7A7A",
    lightRed: "#FF8E8A",
    lightGreen: "#7FFA8A",
    lightYellow: "#FFFFA5",
    lightBlue: "#8B95FF",
    lightMagenta: "#FD7CFC",
    lightCyan: "#9AFEFF",
    lightWhite: "#FFFFFF",
    limeGreen: "#32CD32",
    lightCoral: "#F08080",
  },
} as const;

export const HEAD_THEME = {
  background: HYPER_THEME.background,
  foreground: HYPER_THEME.foreground,
  cursor: HYPER_THEME.cursor,
  header: "#0a0a0a",
  border: "#333333",
  buttonBg: "rgba(255, 255, 255, 0.06)",
  buttonBorder: "rgba(255, 255, 255, 0.15)",
  buttonHover: "rgba(255, 255, 255, 0.14)",
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
