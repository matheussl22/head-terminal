import {
  ACTIVITY_LABEL,
  ACTIVITY_PRIORITY,
  NEEDS_ATTENTION,
  type PaneActivity,
} from "../types/activity";
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

export function getSessionActivityLabel(
  session: AgentSession,
  paneRuntime: Record<string, PaneRuntime>,
): string {
  const activity = getSessionActivity(session, paneRuntime);
  const paneIds = collectPaneIds(session.layout);
  const workingCount = paneIds.filter(
    (paneId) => paneRuntime[paneId]?.activity === "working",
  ).length;

  const label = ACTIVITY_LABEL[activity];
  if (workingCount > 1) {
    return `${label} (${workingCount})`;
  }

  return label;
}

// ponytail: prompt de shell (❯ no fim) gera waiting_input por ~1.5s até decair
// para idle — flap breve na ordenação; expor approvalPending do detector se incomodar.
export function sessionNeedsAttention(
  session: AgentSession,
  paneRuntime: Record<string, PaneRuntime>,
): boolean {
  return NEEDS_ATTENTION.has(getSessionActivity(session, paneRuntime));
}

export function countWorkingSessions(
  sessions: AgentSession[],
  paneRuntime: Record<string, PaneRuntime>,
): number {
  return sessions.filter(
    (session) => getSessionActivity(session, paneRuntime) === "working",
  ).length;
}
