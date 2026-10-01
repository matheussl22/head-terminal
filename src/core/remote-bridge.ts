import type { IDisposable } from "@xterm/xterm";

import {
  describeHibernateBlocker,
  hibernateSessionIfSafe,
  wakeSession,
} from "../actions/hibernateSession";
import { sendTextToPane } from "../actions/sendAgentCommand";
import { AGENT_PROFILE_LABELS } from "../config/agents-shared";
import type {
  RemoteCommand,
  RemoteCommandResult,
  RemoteKey,
  RemoteSessionSummary,
  RemoteSnapshot,
} from "../types/remote";
import type { AgentSession } from "../types/session";
import { msg } from "../i18n";
import { resolvePaneConversationView } from "./conversation-display";
import { logError, logEvent } from "./logger";
import { readRemoteScreen } from "./remote-screen";
import { noteSessionUsed } from "./session-hibernation";
import { collectPaneIds } from "./session-layout";
import { useSessionStore } from "./session-manager";
import { getTerminal } from "./terminal-registry";

/**
 * The renderer's side of the phone remote (main serves it, see
 * electron/services/remote/remote-server.ts). Everything a phone sees is
 * read here, where the state lives: the sessions from the store, a pane's
 * screen from its xterm buffer. Nothing is sent while the remote is off.
 */

/** A burst of store updates (a turn streaming) becomes one snapshot. */
const STATE_THROTTLE_MS = 400;
/** Screen frames per second a phone gets, at most. */
const SCREEN_THROTTLE_MS = 200;
/** A watched pane whose terminal is not up yet (its session sleeps or is
 * waking) is looked for again this often. */
const ATTACH_RETRY_MS = 1_000;
/** Enter after a pasted text: a TUI busy taking in the paste can swallow an
 * Enter that arrives in the same burst. */
const SUBMIT_DELAY_MS = 120;

let watched = new Set<string>();

/** Panes some phone is looking at right now. */
export function getRemoteWatchedPaneIds(): ReadonlySet<string> {
  return watched;
}

type StoreState = ReturnType<typeof useSessionStore.getState>;

function paneTitle(state: StoreState, paneId: string, index: number): string {
  const cliSessionId = state.paneResumeAnchors[paneId];
  const view = resolvePaneConversationView({
    cliSessionId,
    title: cliSessionId ? state.conversationTitles[cliSessionId] : undefined,
    customLabel: cliSessionId
      ? state.conversationLabels[cliSessionId]
      : state.pendingConversationLabels[paneId],
  });
  return view.name ?? msg.terminal.pane.numbered(index);
}

function summarizeSession(state: StoreState, session: AgentSession): RemoteSessionSummary {
  const spawned = Boolean(state.spawnedSessionIds[session.id]);
  const hibernatedAt = state.hibernatedSessions[session.id];
  return {
    sessionId: session.id,
    title: session.title,
    cwd: session.cwd,
    agentProfileId: session.agentProfileId,
    agentLabel: AGENT_PROFILE_LABELS[session.agentProfileId] ?? session.agentProfileId,
    active: state.activeSessionId === session.id,
    pinned: Boolean(session.pinned),
    state: spawned ? "live" : hibernatedAt ? "hibernated" : "not_started",
    ...(hibernatedAt && !spawned ? { hibernatedAt } : {}),
    panes: collectPaneIds(session.layout).map((paneId, position) => {
      const runtime = state.paneRuntime[paneId];
      return {
        paneId,
        index: position + 1,
        title: paneTitle(state, paneId, position + 1),
        agentProfileId: runtime?.runningAgent ?? session.agentProfileId,
        activity: runtime?.activity ?? "starting",
        ...(runtime?.blockedReason ? { blockedReason: runtime.blockedReason } : {}),
        ...(runtime?.blockedDetail ? { blockedDetail: runtime.blockedDetail } : {}),
        done: runtime?.doneAt !== undefined,
        activitySince: runtime?.activitySince ?? 0,
        ...(runtime?.contextPercent !== undefined
          ? { contextPercent: runtime.contextPercent }
          : {}),
      };
    }),
  };
}

export function buildRemoteSnapshot(state: StoreState, now = Date.now()): RemoteSnapshot {
  return {
    sessions: state.sessions.map((session) => summarizeSession(state, session)),
    updatedAt: now,
  };
}

function keySequence(key: RemoteKey, paneId: string): string {
  const applicationCursor = Boolean(
    getTerminal(paneId)?.terminal.modes.applicationCursorKeysMode,
  );
  const arrow = (code: string) => (applicationCursor ? `\x1bO${code}` : `\x1b[${code}`);
  switch (key) {
    case "enter":
      return "\r";
    case "escape":
      return "\x1b";
    case "tab":
      return "\t";
    case "shift-tab":
      return "\x1b[Z";
    case "up":
      return arrow("A");
    case "down":
      return arrow("B");
    case "right":
      return arrow("C");
    case "left":
      return arrow("D");
    case "backspace":
      return "\x7f";
    case "ctrl-c":
      return "\x03";
    case "ctrl-d":
      return "\x04";
    default:
      return key;
  }
}

function sessionOfPane(state: StoreState, paneId: string): AgentSession | undefined {
  return state.sessions.find((session) => collectPaneIds(session.layout).includes(paneId));
}

function fail(error: string): RemoteCommandResult {
  return { ok: false, error };
}

/** A pane that can take input right now, or why not. */
function writablePane(paneId: string): { write: (data: string) => void } | RemoteCommandResult {
  const state = useSessionStore.getState();
  const session = sessionOfPane(state, paneId);
  if (!session) {
    return fail(msg.app.remote.paneGone);
  }
  noteSessionUsed(session.id);
  if (!state.spawnedSessionIds[session.id]) {
    return fail(msg.app.remote.paneAsleep);
  }
  const write = state.ptyWriters[paneId] as ((data: string) => void) | undefined;
  return write ? { write } : fail(msg.app.remote.paneNotRunning);
}

export async function runRemoteCommand(command: RemoteCommand): Promise<RemoteCommandResult> {
  const store = useSessionStore.getState();
  switch (command.type) {
    case "send-text": {
      const target = writablePane(command.paneId);
      if (!("write" in target)) return target;
      sendTextToPane(command.paneId, command.text);
      if (command.submit) {
        await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
        useSessionStore.getState().ptyWriters[command.paneId]?.("\r");
      }
      return { ok: true };
    }
    case "send-key": {
      const target = writablePane(command.paneId);
      if (!("write" in target)) return target;
      target.write(keySequence(command.key, command.paneId));
      return { ok: true };
    }
    case "wake-session": {
      if (!store.sessions.some((session) => session.id === command.sessionId)) {
        return fail(msg.app.remote.sessionGone);
      }
      wakeSession(command.sessionId);
      return { ok: true };
    }
    case "hibernate-session": {
      const outcome = await hibernateSessionIfSafe(command.sessionId, {
        force: true,
        reason: "remote",
      });
      return outcome.ok ? { ok: true } : fail(describeHibernateBlocker(command.sessionId, outcome));
    }
    case "focus-session": {
      if (!store.sessions.some((session) => session.id === command.sessionId)) {
        return fail(msg.app.remote.sessionGone);
      }
      noteSessionUsed(command.sessionId);
      store.setActiveSessionId(command.sessionId);
      if (command.paneId) {
        if (store.minimizedPanes[command.paneId]) {
          store.restorePane(command.paneId);
        }
        useSessionStore.getState().setActivePaneId(command.paneId);
      }
      return { ok: true };
    }
    default:
      return fail(msg.app.remote.unknownCommand);
  }
}

/** Streams one pane's screen while it is watched and its terminal is up. */
class ScreenStream {
  private listeners: IDisposable[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = 0;
  private attachedTo: unknown = null;

  constructor(
    private readonly paneId: string,
    private readonly publish: (paneId: string) => void,
  ) {
    this.attach();
  }

  /** Hooks the pane's current terminal; a new one after a wake. */
  attach(): void {
    const terminal = getTerminal(this.paneId)?.terminal;
    if (terminal === this.attachedTo) return;
    this.detach();
    this.attachedTo = terminal ?? null;
    if (!terminal) return;
    this.listeners.push(
      terminal.onWriteParsed(() => this.schedule()),
      terminal.onResize(() => this.schedule()),
    );
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    const wait = Math.max(0, this.lastSentAt + SCREEN_THROTTLE_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lastSentAt = Date.now();
      this.publish(this.paneId);
    }, wait);
  }

  private detach(): void {
    for (const listener of this.listeners.splice(0)) listener.dispose();
    this.attachedTo = null;
  }

  dispose(): void {
    this.detach();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Wires the remote up; returns the teardown. */
export function startRemoteBridge(): () => void {
  const api = window.headTerminal.remote;
  let running = false;
  let lastPublished = "";
  let stateTimer: ReturnType<typeof setTimeout> | null = null;
  const streams = new Map<string, ScreenStream>();

  const publishState = () => {
    stateTimer = null;
    if (!running) return;
    const snapshot = buildRemoteSnapshot(useSessionStore.getState());
    // updatedAt aside, an unchanged list is not sent again.
    const key = JSON.stringify(snapshot.sessions);
    if (key === lastPublished) return;
    lastPublished = key;
    api.publishState(snapshot);
  };
  const scheduleState = () => {
    if (running && stateTimer === null) {
      stateTimer = setTimeout(publishState, STATE_THROTTLE_MS);
    }
  };

  const publishScreen = (paneId: string) => {
    const terminal = getTerminal(paneId)?.terminal;
    if (!running || !terminal) return;
    try {
      api.publishScreen(readRemoteScreen(paneId, terminal));
    } catch (error) {
      logError("remote.screen_failed", error, { paneId });
    }
  };

  const setWatched = (paneIds: string[]) => {
    watched = new Set(paneIds);
    for (const [paneId, stream] of streams) {
      if (!watched.has(paneId)) {
        stream.dispose();
        streams.delete(paneId);
      }
    }
    for (const paneId of watched) {
      if (!streams.has(paneId)) streams.set(paneId, new ScreenStream(paneId, publishScreen));
    }
  };

  const attachTimer = setInterval(() => {
    for (const stream of streams.values()) stream.attach();
  }, ATTACH_RETRY_MS);

  const applyStatus = (status: { running: boolean }) => {
    const wasRunning = running;
    running = status.running;
    if (running && !wasRunning) {
      lastPublished = "";
      scheduleState();
    }
    if (!running) setWatched([]);
  };

  const unsubscribers = [
    useSessionStore.subscribe(scheduleState),
    api.onStatus(applyStatus),
    api.onWatch(setWatched),
    api.onCommand((request) => {
      logEvent("info", "remote.command", { type: request.command.type });
      void runRemoteCommand(request.command)
        .catch((error: unknown): RemoteCommandResult => {
          logError("remote.command_failed", error, { type: request.command.type });
          return fail(error instanceof Error ? error.message : String(error));
        })
        .then((result) => api.replyCommand({ requestId: request.requestId, result }));
    }),
  ];
  void api
    .getStatus()
    .then(async (status) => {
      applyStatus(status);
      // A reloaded window: phones may already be looking at panes.
      if (status.running) setWatched(await api.getWatched());
    })
    .catch((error: unknown) => logError("remote.status_failed", error));

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    clearInterval(attachTimer);
    if (stateTimer !== null) clearTimeout(stateTimer);
    setWatched([]);
    running = false;
  };
}
