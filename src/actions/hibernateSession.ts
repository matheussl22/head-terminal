import { confirmInApp } from "../core/confirm-dialog";
import { capturePaneForHibernation } from "../core/hibernation-snapshots";
import { logError, logEvent } from "../core/logger";
import { getRemoteWatchedPaneIds } from "../core/remote-bridge";
import {
  checkSessionHibernation,
  isHibernationCandidate,
  noteSessionUsed,
  paneKind,
  panePtyId,
  processBlocker,
  type HibernationBlocker,
  type HibernationCandidate,
} from "../core/session-hibernation";
import { collectPaneIds } from "../core/session-layout";
import { useSessionStore } from "../core/session-manager";
import { loadHibernateAfterMinutes } from "../core/ui-preferences";
import { msg } from "../i18n";

export type HibernateOutcome =
  | { ok: true; memoryBytes: number }
  | { ok: false; blocker: HibernationBlocker; paneId?: string; detail?: string };

/** After a pane is found busy with processes, it is not inspected again for
 * this long: the process table costs a second of PowerShell on Windows. */
const PROCESS_RECHECK_MS = 10 * 60_000;
const processBlocked = new Map<
  string,
  { until: number; outcome: Extract<HibernateOutcome, { ok: false }> }
>();

function idleMs(): number {
  return loadHibernateAfterMinutes() * 60_000;
}

function check(sessionId: string, force: boolean) {
  return checkSessionHibernation(useSessionStore.getState(), sessionId, {
    now: Date.now(),
    idleMs: idleMs(),
    watchedPaneIds: getRemoteWatchedPaneIds(),
    force,
  });
}

/** Stops the session's terminals; the shells' scrollback is kept to replay. */
function putToSleep(sessionId: string, kinds: Map<string, "agent" | "shell">): boolean {
  const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
  if (!session) {
    return false;
  }
  for (const paneId of collectPaneIds(session.layout)) {
    capturePaneForHibernation(paneId, kinds.get(paneId) !== "agent");
  }
  return useSessionStore.getState().hibernateSession(sessionId);
}

/**
 * Puts a session to sleep if nothing in it would be lost: every pane at
 * rest, quiet long enough (unless `force`), and nothing running under it.
 * `force` (the user asked) only waives the "unused for long enough" rules.
 */
export async function hibernateSessionIfSafe(
  sessionId: string,
  options: { force?: boolean; reason: "idle" | "manual" | "remote" },
): Promise<HibernateOutcome> {
  const force = options.force ?? false;
  const first = check(sessionId, force);
  if (!isHibernationCandidate(first)) {
    return { ok: false, blocker: first.blocker, paneId: first.paneId };
  }
  const recent = processBlocked.get(sessionId);
  if (!force && recent && recent.until > Date.now()) {
    return recent.outcome;
  }

  // Main knows each process by its pty, not by its pane.
  const ptyIds = new Map(
    first.panes.flatMap((pane) => {
      const ptyId = panePtyId(pane.paneId);
      return ptyId ? [[pane.paneId, ptyId] as const] : [];
    }),
  );
  const byPty = await window.headTerminal.terminal.inspect([...ptyIds.values()]);
  const inspections = Object.fromEntries(
    [...ptyIds].map(([paneId, ptyId]) => [paneId, byPty[ptyId]]),
  );
  for (const pane of first.panes) {
    const inspection = inspections[pane.paneId];
    if (processBlocker(pane.kind, inspection)) {
      const names =
        pane.kind === "shell" ? inspection?.children : inspection?.detachedShells;
      const outcome = {
        ok: false as const,
        blocker: "processes" as const,
        paneId: pane.paneId,
        detail: [...new Set(names ?? [])].slice(0, 3).join(", "),
      };
      processBlocked.set(sessionId, { until: Date.now() + PROCESS_RECHECK_MS, outcome });
      return outcome;
    }
  }
  processBlocked.delete(sessionId);

  // The process table took a while: the user may have come back meanwhile.
  const second = check(sessionId, force);
  if (!isHibernationCandidate(second)) {
    return { ok: false, blocker: second.blocker, paneId: second.paneId };
  }

  const memoryBytes = second.panes.reduce(
    (total, pane) => total + (inspections[pane.paneId]?.memoryBytes ?? 0),
    0,
  );
  if (!putToSleep(sessionId, new Map(second.panes.map((pane) => [pane.paneId, pane.kind])))) {
    return { ok: false, blocker: "not_spawned" };
  }
  logEvent("info", "session.hibernated", {
    sessionId,
    reason: options.reason,
    panes: second.panes.length,
    memoryMb: Math.round(memoryBytes / (1024 * 1024)),
  });
  return { ok: true, memoryBytes };
}

function paneNumber(sessionId: string, paneId: string | undefined): number {
  const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
  const index = session && paneId ? collectPaneIds(session.layout).indexOf(paneId) : -1;
  return index + 1;
}

/** Why a session could not sleep, in words. */
export function describeHibernateBlocker(
  sessionId: string,
  outcome: Extract<HibernateOutcome, { ok: false }>,
): string {
  const text = msg.app.hibernate.blocked;
  const pane = paneNumber(sessionId, outcome.paneId);
  switch (outcome.blocker) {
    case "busy":
      return text.busy(pane);
    case "processes":
      return text.processes(pane, outcome.detail ?? "");
    case "unanchored":
      return text.unanchored(pane);
    case "profile":
      return text.profile(pane);
    case "watched":
      return text.watched(pane);
    case "not_spawned":
      return text.notSpawned;
    default:
      return text.recent;
  }
}

/**
 * "Hibernar agora" from the session menu. What would not come back intact
 * is said first, and the user decides.
 */
export async function hibernateSessionFromMenu(sessionId: string): Promise<void> {
  try {
    const outcome = await hibernateSessionIfSafe(sessionId, { force: true, reason: "manual" });
    if (outcome.ok || outcome.blocker === "not_spawned") {
      return;
    }
    const confirmed = await confirmInApp({
      title: msg.app.hibernate.confirmTitle,
      message: describeHibernateBlocker(sessionId, outcome),
      detail: msg.app.hibernate.confirmDetail,
      confirmLabel: msg.app.hibernate.confirm,
      cancelLabel: msg.app.hibernate.cancel,
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }
    const { paneRuntime } = useSessionStore.getState();
    const kinds = new Map(
      collectPaneIds(session.layout).map((paneId) => [
        paneId,
        paneKind(session, paneRuntime[paneId]) ?? ("shell" as const),
      ]),
    );
    if (putToSleep(sessionId, kinds)) {
      logEvent("info", "session.hibernated", {
        sessionId,
        reason: "manual_forced",
        blocker: outcome.blocker,
      });
    }
  } catch (error) {
    logError("session.hibernate_failed", error, { sessionId });
  }
}

/** Starts a sleeping session's terminals in the background. */
export function wakeSession(sessionId: string): void {
  noteSessionUsed(sessionId);
  useSessionStore.getState().wakeSession(sessionId);
}

export type { HibernationCandidate };
