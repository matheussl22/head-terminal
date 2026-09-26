import type { AgentHookEvent } from "../types/agent-hooks";

type Listener = (event: AgentHookEvent) => void;

const listeners = new Map<string, Set<Listener>>();
let unsubscribeIpc: (() => void) | null = null;

function hooksApi() {
  return typeof window === "undefined" ? undefined : window.headTerminal?.agentHooks;
}

function ensureIpcSubscription(): void {
  if (unsubscribeIpc) {
    return;
  }
  const api = hooksApi();
  if (!api) {
    return;
  }
  unsubscribeIpc = api.onEvent((event) => {
    listeners.get(event.paneId)?.forEach((listener) => {
      // One pane's broken listener must not starve the others of the event.
      try {
        listener(event);
      } catch {
        // Nothing to recover: the next event carries the state again.
      }
    });
  });
}

/**
 * Hook events for one pane. One IPC subscription serves every pane; the
 * events are routed by the pane id the hook echoed back.
 */
export function subscribeAgentHookEvents(paneId: string, listener: Listener): () => void {
  ensureIpcSubscription();
  let paneListeners = listeners.get(paneId);
  if (!paneListeners) {
    paneListeners = new Set();
    listeners.set(paneId, paneListeners);
  }
  paneListeners.add(listener);

  return () => {
    const current = listeners.get(paneId);
    current?.delete(listener);
    if (current && current.size === 0) {
      listeners.delete(paneId);
    }
  };
}

/**
 * The `--settings` file a Claude pane is launched with so it reports its own
 * state. One file per pane, asked on every spawn: the main process makes sure
 * it still exists (Claude refuses to start on a missing settings file).
 * Undefined — hooks unavailable — and the pane falls back to its title and
 * screen.
 */
export function getClaudeHookSettingsPath(paneId: string): Promise<string | undefined> {
  const api = hooksApi();
  return api
    ? api
        .getClaudeSettings(paneId)
        .then((settings) => settings?.settingsPath || undefined)
        .catch(() => undefined)
    : Promise.resolve(undefined);
}

/** Tests only. */
export function resetAgentHooksBridgeForTests(): void {
  unsubscribeIpc?.();
  unsubscribeIpc = null;
  listeners.clear();
}
