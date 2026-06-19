import {
  ACTIVITY_LABEL,
  ACTIVITY_PRIORITY,
  type PaneActivity,
} from "../types/activity";
import { collectPaneIds } from "./session-layout";
import type { AgentSession } from "../types/session";

export function aggregatePaneActivity(
  activities: Record<string, PaneActivity>,
  paneIds: string[],
): PaneActivity {
  if (paneIds.length === 0) {
    return "starting";
  }

  let best: PaneActivity = "exited";

  for (const paneId of paneIds) {
    const activity = activities[paneId] ?? "starting";
    if (ACTIVITY_PRIORITY[activity] > ACTIVITY_PRIORITY[best]) {
      best = activity;
    }
  }

  return best;
}

export function getSessionActivity(
  session: AgentSession,
  paneActivities: Record<string, PaneActivity>,
): PaneActivity {
  const paneIds = collectPaneIds(session.layout);
  return aggregatePaneActivity(paneActivities, paneIds);
}

export function getSessionActivityLabel(
  session: AgentSession,
  paneActivities: Record<string, PaneActivity>,
): string {
  const activity = getSessionActivity(session, paneActivities);
  const paneIds = collectPaneIds(session.layout);
  const workingCount = paneIds.filter(
    (paneId) => paneActivities[paneId] === "working",
  ).length;

  const label = ACTIVITY_LABEL[activity];
  if (workingCount > 1) {
    return `${label} (${workingCount})`;
  }

  return label;
}

export function countWorkingSessions(
  sessions: AgentSession[],
  paneActivities: Record<string, PaneActivity>,
): number {
  return sessions.filter(
    (session) => getSessionActivity(session, paneActivities) === "working",
  ).length;
}
