import type { ITerminalOptions, ITheme } from "@xterm/xterm";

import { loadFontSize } from "../core/ui-preferences";

// Mirrors ~/.hyper.js — font, palette and accent colors.
export const HYPER_THEME = {
  fontFamily:
    'Menlo, "DejaVu Sans Mono", Consolas, "Lucida Console", monospace',
  fontSize: 12,
  lineHeight: 1,
  letterSpacing: 0,
  foreground: "#ffffff",
  background: "#050609",
  cursor: "#a78bfa",
  cursorAccent: "#050609",
  selection: "rgba(125, 211, 252, 0.28)",
  accent: "#7dd3fc",
  accentMuted: "rgba(125, 211, 252, 0.34)",
  enabled: "#67f86f",
  enabledMuted: "rgba(103, 248, 111, 0.2)",
  terminalPadding: "12px 14px",
  colors: {
    black: "#000000",
    red: "#C51E14",
    green: "#1DC121",
    yellow: "#C7C329",
    blue: "#0A2FC4",
    magenta: "#C839C5",
    cyan: "#20C5C6",
    white: "#C7C7C7",
    lightBlack: "#686868",
    lightRed: "#FD6F6B",
    lightGreen: "#67F86F",
    lightYellow: "#FFFA72",
    lightBlue: "#6A76FB",
    lightMagenta: "#FD7CFC",
    lightCyan: "#68FDFE",
    lightWhite: "#FFFFFF",
    limeGreen: "#32CD32",
    lightCoral: "#F08080",
  },
} as const;

export const HEAD_THEME = {
  background: HYPER_THEME.background,
  foreground: HYPER_THEME.foreground,
  cursor: HYPER_THEME.cursor,
  header: "#0d0f16",
  border: "rgba(255, 255, 255, 0.12)",
  buttonBg: "rgba(255, 255, 255, 0.06)",
  buttonBorder: "rgba(255, 255, 255, 0.15)",
  buttonHover: "rgba(125, 211, 252, 0.1)",
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

export function createTerminalOptions(): ITerminalOptions {
  return {
    convertEol: true,
    cursorBlink: false,
    cursorStyle: "block",
    fontSize: loadFontSize(),
    fontFamily: HYPER_THEME.fontFamily,
    lineHeight: HYPER_THEME.lineHeight,
    letterSpacing: HYPER_THEME.letterSpacing,
    theme: createXtermTheme(),
  };
}
