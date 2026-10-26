import { fitPanes } from "./pane-fit-registry";
import { useSessionStore } from "./session-manager";
import { forEachTerminal } from "./terminal-registry";
import { loadFontSize, saveFontSize } from "./ui-preferences";

export const DEFAULT_FONT_SIZE = 12;

/**
 * Saves the terminal font size and applies it to every open pane. Saving
 * alone only reached terminals created afterwards: the settings field used
 * to do just that, so typing a new size changed nothing on screen until the
 * app was restarted. A non-number (the field emptied) leaves everything as is.
 */
export function applyFontSize(size: number): number {
  if (!Number.isFinite(size)) {
    return loadFontSize();
  }
  saveFontSize(size);
  const next = loadFontSize();
  forEachTerminal((_paneId, handle) => {
    handle.terminal.options.fontSize = next;
  });
  fitPanes(useSessionStore.getState().getTargetPaneIds());
  return next;
}
