import { ACTIVITY_PRIORITY, type PaneActivity } from "../types/activity";
import {
  describeSessionStatus,
  paneStatusTone,
  type SessionStatusView,
} from "./activity-display";
import { collectPaneIds } from "./session-layout";
import type { PaneRuntime } from "./session-manager";
import type { AgentSession } from "../types/session";

export function aggregatePaneActivity(
  paneRuntime: Record<string, PaneRuntime>,
  paneIds: string[],
): PaneActivity {
  if (paneIds.length === 0) {
    return "starting";
  }

  let best: PaneActivity = "exited";

  for (const paneId of paneIds) {
    const activity = paneRuntime[paneId]?.activity ?? "starting";
    if (ACTIVITY_PRIORITY[activity] > ACTIVITY_PRIORITY[best]) {
      best = activity;
    }
  }

  return best;
}

export function getSessionActivity(
  session: AgentSession,
  paneRuntime: Record<string, PaneRuntime>,
): PaneActivity {
  const paneIds = collectPaneIds(session.layout);
  return aggregatePaneActivity(paneRuntime, paneIds);
}

/**
 * When the session's aggregated activity started: the pane that has been in
 * it the longest. A pane blocked for ten minutes is the story, not the
 * sibling that got there a second ago.
 */
export function getSessionActivitySince(
  session: AgentSession,
  paneRuntime: Record<string, PaneRuntime>,
): number | undefined {
  const paneIds = collectPaneIds(session.layout);
  const activity = aggregatePaneActivity(paneRuntime, paneIds);
  let since: number | undefined;
  for (const paneId of paneIds) {
    const runtime = paneRuntime[paneId];
    if (runtime?.activity === activity && (since === undefined || runtime.activitySince < since)) {
      since = runtime.activitySince;
    }
  }
  return since;
}

/** Some pane of the session is doing work right now — whatever its siblings
 * are up to. A pane asking for approval must not hide one still running from
 * the "N executando" count or the close confirmations. */
export function getSessionHasWorkingPane(
  session: AgentSession,
  paneRuntime: Record<string, PaneRuntime>,
): boolean {
  return collectPaneIds(session.layout).some(
    (paneId) => paneRuntime[paneId]?.activity === "working",
  );
}

export interface TerminalStatusCounts {
  waiting: number;
  working: number;
  done: number;
}

/**
 * How many terminals, across every started session, are blocked on the user,
 * still working, or finished unseen. Counted per terminal, not per session:
 * with ten agents open, "2 aguardando" should mean two answers owed. The
 * toolbar chips, the sidebar, the window title and the close confirmation all
 * count through here, so they never disagree.
 */
export function countTerminalStatuses(
  sessions: AgentSession[],
  paneRuntime: Record<string, PaneRuntime | undefined>,
  spawnedSessionIds: Record<string, boolean>,
): TerminalStatusCounts {
  const counts: TerminalStatusCounts = { waiting: 0, working: 0, done: 0 };
  for (const session of sessions) {
    if (!spawnedSessionIds[session.id]) {
      continue;
    }
    for (const paneId of collectPaneIds(session.layout)) {
      const tone = paneStatusTone(paneRuntime[paneId]);
      if (tone === "waiting" || tone === "working" || tone === "done") {
        counts[tone] += 1;
      }
    }
  }
  return counts;
}

/** "● 2 executando · 1 aguardando — Head Terminal", by terminal like the
 * toolbar chips; just `base` when nothing is running or blocked. */
export function formatWindowTitle(base: string, counts: TerminalStatusCounts): string {
  const parts: string[] = [];
  if (counts.working > 0) {
    parts.push(`${counts.working} executando`);
  }
  if (counts.waiting > 0) {
    parts.push(`${counts.waiting} aguardando`);
  }
  return parts.length > 0 ? `● ${parts.join(" · ")} — ${base}` : base;
}

/** What closing the app would cut short, or null when nothing would: a
 * terminal blocked on an approval is a turn stopped half-way, as much at
 * stake as one still running. */
export function formatCloseWarning(counts: TerminalStatusCounts): string | null {
  const busy = counts.working + counts.waiting;
  return busy > 0 ? `${busy} agent(s) executando ou aguardando você.` : null;
}

export function countWorkingSessions(
  sessions: AgentSession[],
  paneRuntime: Record<string, PaneRuntime>,
): number {
  return sessions.filter((session) => getSessionHasWorkingPane(session, paneRuntime)).length;
}

/** The session's status as the UI shows it, "Não iniciada" included: only
 * the sessions the user opened spawn, the others have nothing running. */
export function getSessionStatusView(
  session: AgentSession,
  paneRuntime: Record<string, PaneRuntime>,
  spawnedSessionIds: Record<string, boolean>,
): SessionStatusView {
  return describeSessionStatus(collectPaneIds(session.layout), paneRuntime, {
    spawned: Boolean(spawnedSessionIds[session.id]),
  });
}
