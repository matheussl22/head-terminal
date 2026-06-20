import { useEffect, useState } from "react";

import { getSessionActivity } from "../core/activity-utils";
import { useSessionStore } from "../core/session-manager";
import { notifySessionAttention } from "../core/notifications";

export function useActivityNotifications(): void {
  const sessions = useSessionStore((state) => state.sessions);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const paneActivities = useSessionStore((state) => state.paneActivities);

  useEffect(() => {
    for (const session of sessions) {
      if (session.id === activeSessionId && document.hasFocus()) {
        continue;
      }

      const activity = getSessionActivity(session, paneActivities);
      void notifySessionAttention(session.title, activity, session.id);
    }
  }, [activeSessionId, paneActivities, sessions]);
}

export function useKeyboardShortcuts(options: {
  onCommandPalette: () => void;
  onRenameSession: () => void;
}): void {
  const sessions = useSessionStore((state) => state.sessions);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const setActiveSessionId = useSessionStore((state) => state.setActiveSessionId);
  const splitActivePane = useSessionStore((state) => state.splitActivePane);
  const activePaneId = useSessionStore((state) => state.activePaneId);
  const closePane = useSessionStore((state) => state.closePane);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement;

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        options.onCommandPalette();
        return;
      }

      if (!isInput && event.key === "F2") {
        event.preventDefault();
        options.onRenameSession();
        return;
      }

      if (!isInput && event.ctrlKey && event.key === "\\") {
        event.preventDefault();
        if (event.shiftKey) {
          splitActivePane("horizontal");
        } else {
          splitActivePane("vertical");
        }
        return;
      }

      if (
        !isInput &&
        event.ctrlKey &&
        event.shiftKey &&
        event.key.toLowerCase() === "w"
      ) {
        event.preventDefault();
        if (activePaneId) {
          closePane(activePaneId);
        }
        return;
      }

      if (isInput || !event.ctrlKey || event.metaKey) {
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        if (sessions.length < 2) {
          return;
        }

        const currentIndex = sessions.findIndex(
          (session) => session.id === activeSessionId,
        );
        const delta = event.shiftKey ? -1 : 1;
        const nextIndex =
          (currentIndex + delta + sessions.length) % sessions.length;
        setActiveSessionId(sessions[nextIndex].id);
        return;
      }

      const digit = Number.parseInt(event.key, 10);
      if (digit >= 1 && digit <= 9 && sessions[digit - 1]) {
        event.preventDefault();
        setActiveSessionId(sessions[digit - 1].id);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activePaneId,
    activeSessionId,
    closePane,
    options,
    sessions,
    setActiveSessionId,
    splitActivePane,
  ]);
}

export function useRenameRequest(): {
  renameSessionId: string | null;
  requestRename: (sessionId: string) => void;
  clearRenameRequest: () => void;
} {
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);

  return {
    renameSessionId,
    requestRename: setRenameSessionId,
    clearRenameRequest: () => setRenameSessionId(null),
  };
}
