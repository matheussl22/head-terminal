import { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal } from "@xterm/xterm";

import { getTerminal } from "./terminal-registry";

/**
 * What a sleeping pane shows again when it wakes. A shell's scrollback is
 * gone with its terminal, so it is kept here as text with its colors and
 * replayed into the new terminal before the new shell paints. An agent pane
 * keeps nothing: resuming the conversation redraws it.
 */
interface Snapshot {
  scrollback?: string;
}

/** Enough to see what was going on, not the whole 5000-line scrollback. */
const SNAPSHOT_LINES = 1_000;

const snapshots = new Map<string, Snapshot>();

function serialize(terminal: Terminal): string | undefined {
  const addon = new SerializeAddon();
  try {
    terminal.loadAddon(addon);
    return addon.serialize({ scrollback: SNAPSHOT_LINES });
  } catch {
    return undefined;
  } finally {
    addon.dispose();
  }
}

/** Taken right before the pane's terminal goes away. */
export function capturePaneForHibernation(paneId: string, keepScrollback: boolean): void {
  const terminal = getTerminal(paneId)?.terminal;
  snapshots.set(paneId, {
    scrollback: keepScrollback && terminal ? serialize(terminal) : undefined,
  });
}

/** What to replay when the pane wakes; undefined unless it slept. Once. */
export function takeHibernationSnapshot(paneId: string): Snapshot | undefined {
  const snapshot = snapshots.get(paneId);
  snapshots.delete(paneId);
  return snapshot;
}

export function forgetHibernationSnapshot(paneId: string): void {
  snapshots.delete(paneId);
}
