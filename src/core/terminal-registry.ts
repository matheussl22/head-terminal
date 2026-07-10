import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";

export interface TerminalHandle {
  terminal: Terminal;
  searchAddon?: SearchAddon;
}

const terminals = new Map<string, TerminalHandle>();

export function registerTerminal(paneId: string, handle: TerminalHandle): void {
  terminals.set(paneId, handle);
}

export function unregisterTerminal(paneId: string): void {
  terminals.delete(paneId);
}

export function getTerminal(paneId: string): TerminalHandle | undefined {
  return terminals.get(paneId);
}

export function forEachTerminal(
  fn: (paneId: string, handle: TerminalHandle) => void,
): void {
  for (const [paneId, handle] of terminals) {
    fn(paneId, handle);
  }
}
