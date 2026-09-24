import type { ITerminalOptions } from "@xterm/xterm";

import { getActiveTerminalTheme } from "../core/theme-manager";
import { loadFontSize } from "../core/ui-preferences";
import { getCachedPlatformInfo, isMacHost } from "../core/platform-info";

// Fonte e métricas são iguais em todos os temas; as cores vêm do tema ativo
// (src/config/themes.ts) e podem trocar em tempo de execução.
export const HYPER_THEME = {
  fontFamily:
    'Menlo, "Cascadia Mono", "DejaVu Sans Mono", Consolas, "Lucida Console", monospace',
  fontSize: 12,
  lineHeight: 1,
  letterSpacing: 0,
  terminalPadding: "10px 12px",
} as const;

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

/**
 * `convertEol` faz todo LF virar CR+LF. Isso serve para shells Unix que
 * emitem "
" solto, mas quebra o ConPTY: ele usa LF puro para descer uma
 * linha mantendo a coluna, e com a conversão o cursor volta para a coluna 0.
 * Uma linha da UI do Claude Code que deveria começar na coluna 2 é então
 * escrita na coluna 0; no frame seguinte o ConPTY só reenvia o trecho que
 * ele acha que mudou (colunas 2+) e as duas primeiras colunas ficam com o
 * texto deslocado — os "caracteres fantasma" na borda esquerda do pane.
 */
function resolveConvertEol(): boolean {
  const info = getCachedPlatformInfo();
  return info?.platform !== "win32";
}

export function createTerminalOptions(): ITerminalOptions {
  return {
    convertEol: resolveConvertEol(),
    cursorBlink: false,
    cursorStyle: "block",
    fontSize: loadFontSize(),
    fontFamily: HYPER_THEME.fontFamily,
    lineHeight: HYPER_THEME.lineHeight,
    letterSpacing: HYPER_THEME.letterSpacing,
    drawBoldTextInBrightColors: true,
    // Lift near-black ANSI colors so they never vanish on #000.
    minimumContrastRatio: 4.5,
    theme: getActiveTerminalTheme(),
    windowsPty: resolveWindowsPty(),
    // On a Mac keyboard Option is the only Meta there is: without this,
    // ⌥B / ⌥F / ⌥Enter type accented characters into the shell instead of
    // the word-jump and newline escapes the agents and readline expect.
    macOptionIsMeta: isMacHost(),
  };
}
