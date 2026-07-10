import { NEEDS_ATTENTION, type PaneActivity } from "../types/activity";

const notifiedKeys = new Set<string>();

function notificationKey(sessionId: string, activity: PaneActivity): string {
  return `${sessionId}:${activity}`;
}

export async function notifySessionAttention(
  sessionTitle: string,
  activity: PaneActivity,
  sessionId: string,
): Promise<void> {
  if (!NEEDS_ATTENTION.has(activity)) {
    return;
  }

  if (document.hasFocus()) {
    return;
  }

  const key = notificationKey(sessionId, activity);
  if (notifiedKeys.has(key)) {
    return;
  }

  notifiedKeys.add(key);

  const body =
    activity === "error"
      ? `${sessionTitle} encontrou um erro`
      : activity === "agent_fallback"
        ? `${sessionTitle}: o agent caiu — shell ativo`
        : `${sessionTitle} precisa de atenção`;

  if (!("Notification" in window)) {
    return;
  }

  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }

  if (Notification.permission === "granted") {
    new Notification("Head Terminal", { body });
  }
}

export function clearSessionNotification(sessionId: string): void {
  for (const key of notifiedKeys) {
    if (key.startsWith(`${sessionId}:`)) {
      notifiedKeys.delete(key);
    }
  }
}
