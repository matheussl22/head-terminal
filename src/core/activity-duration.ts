import { ACTIVITY_LABEL, type PaneActivity } from "../types/activity";

const TICK_ACTIVITIES: ReadonlySet<PaneActivity> = new Set([
  "working",
  "waiting_input",
  "error",
  "agent_fallback",
]);

export function formatActivityDuration(sinceMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - sinceMs) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h${rem}m` : `${hours}h`;
}

export function formatSessionStatusLine(
  activity: PaneActivity,
  activitySince: number | undefined,
  now = Date.now(),
): string {
  const label = ACTIVITY_LABEL[activity];
  if (!activitySince || !TICK_ACTIVITIES.has(activity)) {
    return label;
  }
  return `${label} há ${formatActivityDuration(activitySince, now)}`;
}
