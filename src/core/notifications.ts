import { BLOCKED_REASON_LABEL } from "../types/activity";
import {
  describeSessionStatus,
  paneStatusTone,
  type PaneStatusRuntime,
  type PaneStatusTone,
} from "./activity-display";
import { logError } from "./logger";
import { paneShortLabel } from "./pane-labels";

export interface SessionNotification {
  tone: PaneStatusTone;
  body: string;
  /** The terminal it is about, so a click can bring that pane on screen. */
  paneId?: string;
}

/**
 * What a session's status is worth telling the user, if anything: it needs
 * them (an approval, a question, a confirmation) or something broke. A
 * voluntary /exit (code 0) is not news. A finished turn is told per terminal
 * instead (see paneDoneNotifications): a sibling still at work, or waiting,
 * must not swallow it.
 */
export function sessionNotification(
  title: string,
  paneIds: string[],
  paneRuntime: Record<string, PaneStatusRuntime | undefined>,
  options: { spawned?: boolean } = {},
): SessionNotification | null {
  const view = describeSessionStatus(paneIds, paneRuntime, options);
  switch (view.tone) {
    case "waiting": {
      // The pane that has been waiting longest speaks, as in the sidebar.
      let waiting: PaneStatusRuntime | undefined;
      let waitingPaneId: string | undefined;
      for (const paneId of paneIds) {
        const runtime = paneRuntime[paneId];
        if (
          runtime?.activity === "waiting_input" &&
          (!waiting || runtime.activitySince < waiting.activitySince)
        ) {
          waiting = runtime;
          waitingPaneId = paneId;
        }
      }
      const reason = waiting?.blockedReason
        ? BLOCKED_REASON_LABEL[waiting.blockedReason]
        : "espera sua resposta";
      const detail = waiting?.blockedDetail ? ` (${waiting.blockedDetail})` : "";
      return { tone: view.tone, body: `${title}: ${reason}${detail}`, paneId: waitingPaneId };
    }
    case "error": {
      // The failed terminal, so a click brings it — and its "Reiniciar" — out
      // of the dock or from behind a zoomed sibling.
      const failed = paneIds.find((paneId) => paneRuntime[paneId]?.activity === "error");
      return {
        tone: view.tone,
        body: `${title} encontrou um erro`,
        ...(failed ? { paneId: failed } : {}),
      };
    }
    case "fallback": {
      const crashed = paneIds.find((paneId) => {
        const runtime = paneRuntime[paneId];
        return runtime?.activity === "agent_fallback" && runtime.agentExitCode !== 0;
      });
      return crashed
        ? { tone: view.tone, body: `${title}: o agent caiu — shell ativo`, paneId: crashed }
        : null;
    }
    default:
      return null;
  }
}

export interface PaneDoneNotification {
  paneId: string;
  /** The finished turn this is about: one notification per turn. */
  doneAt: number;
  body: string;
}

/**
 * One "concluiu" per terminal holding a finished turn nobody saw, whatever
 * its siblings are doing: "api: cc3 concluiu", with the same short name the
 * pane header shows. A session with a single terminal needs only its title.
 */
export function paneDoneNotifications(
  session: { title: string; agentProfileId: string },
  paneIds: string[],
  paneRuntime: Record<string, PaneStatusRuntime | undefined>,
  options: { spawned?: boolean } = {},
): PaneDoneNotification[] {
  if (options.spawned === false) {
    return [];
  }
  const notifications: PaneDoneNotification[] = [];
  paneIds.forEach((paneId, index) => {
    const runtime = paneRuntime[paneId];
    if (!runtime || runtime.doneAt === undefined || paneStatusTone(runtime) !== "done") {
      return;
    }
    const who =
      paneIds.length > 1
        ? `${session.title}: ${paneShortLabel(session.agentProfileId, index)}`
        : session.title;
    notifications.push({ paneId, doneAt: runtime.doneAt, body: `${who} concluiu` });
  });
  return notifications;
}

function showNotification(sessionId: string, body: string, paneId?: string): void {
  void window.headTerminal.notifications
    .show({ title: "Head Terminal", body, sessionId, ...(paneId ? { paneId } : {}) })
    .catch((error: unknown) => {
      logError("notifications.show_failed", error, { sessionId });
    });
}

/** sessionId -> the tone already told (or seen) in the session's current
 * stretch of it. Leaving that tone forgets it, so the next real occurrence
 * notifies again. */
const handledTones = new Map<string, PaneStatusTone>();

/** paneId -> the finished turn (its doneAt) already told, or seen. */
const handledDoneAt = new Map<string, number>();

/**
 * Shows `notification` for a session once per stretch of its tone. Nothing is
 * shown for the session the user is looking at. What the user saw with their
 * own eyes counts as told: switching away later does not replay it.
 */
export function notifySessionStatus(
  sessionId: string,
  notification: SessionNotification | null,
  context: { sessionActive: boolean; windowFocused: boolean },
): void {
  const handled = handledTones.get(sessionId);
  if (!notification) {
    handledTones.delete(sessionId);
    return;
  }
  if (handled === notification.tone) {
    return;
  }
  handledTones.set(sessionId, notification.tone);

  if (context.sessionActive && context.windowFocused) {
    return;
  }
  showNotification(sessionId, notification.body, notification.paneId);
}

/**
 * Tells a terminal's finished turn once. Only while the window is in the
 * background: with the app in front, the pane, the sidebar and the toolbar
 * already say "Concluído" — and a turn that ended in front of the user
 * counts as told, so leaving the window later does not replay it.
 */
export function notifyPaneDone(
  sessionId: string,
  notification: PaneDoneNotification,
  context: { windowFocused: boolean },
): void {
  if (handledDoneAt.get(notification.paneId) === notification.doneAt) {
    return;
  }
  handledDoneAt.set(notification.paneId, notification.doneAt);

  if (context.windowFocused) {
    return;
  }
  showNotification(sessionId, notification.body, notification.paneId);
}

/** Forgets what was told about a session (closed, or restarted from scratch). */
export function clearSessionNotification(sessionId: string): void {
  handledTones.delete(sessionId);
}

/** Drops the bookkeeping of sessions that no longer exist and of finished
 * turns no longer pending (seen, the pane moved on, or it was closed). */
export function pruneSessionNotifications(
  liveSessionIds: ReadonlySet<string>,
  finishedPaneIds: ReadonlySet<string>,
): void {
  for (const sessionId of handledTones.keys()) {
    if (!liveSessionIds.has(sessionId)) {
      handledTones.delete(sessionId);
    }
  }
  for (const paneId of handledDoneAt.keys()) {
    if (!finishedPaneIds.has(paneId)) {
      handledDoneAt.delete(paneId);
    }
  }
}

/** Tests only. */
export function resetNotificationsForTests(): void {
  handledTones.clear();
  handledDoneAt.clear();
}
