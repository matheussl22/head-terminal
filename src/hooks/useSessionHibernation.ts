import { useEffect } from "react";

import { hibernateSessionIfSafe } from "../actions/hibernateSession";
import { logError } from "../core/logger";
import { getRemoteWatchedPaneIds } from "../core/remote-bridge";
import {
  findHibernationCandidates,
  noteSessionUsed,
} from "../core/session-hibernation";
import { useSessionStore } from "../core/session-manager";
import { loadHibernateAfterMinutes } from "../core/ui-preferences";

/** How often sessions are looked at. Hibernation is measured in tens of
 * minutes, so a minute late is nothing. */
const CHECK_INTERVAL_MS = 60_000;

/**
 * Puts sessions nobody uses to sleep once they have been idle for the time
 * set in Settings (see session-hibernation.ts). A session is "used" while it
 * is on screen and whenever it is typed into, woken or driven from a phone.
 */
export function useSessionHibernation(): void {
  useEffect(() => {
    // Leaving a session counts as having just used it: a session left a
    // second ago is not idle, however long its panes have been quiet.
    let previous = useSessionStore.getState().activeSessionId;
    if (previous) {
      noteSessionUsed(previous);
    }
    const unsubscribe = useSessionStore.subscribe((state) => {
      if (state.activeSessionId === previous) {
        return;
      }
      if (previous) {
        noteSessionUsed(previous);
      }
      if (state.activeSessionId) {
        noteSessionUsed(state.activeSessionId);
      }
      previous = state.activeSessionId;
    });

    let checking = false;
    const check = async () => {
      const minutes = loadHibernateAfterMinutes();
      if (checking || minutes <= 0) {
        return;
      }
      checking = true;
      try {
        const candidates = findHibernationCandidates(useSessionStore.getState(), {
          now: Date.now(),
          idleMs: minutes * 60_000,
          watchedPaneIds: getRemoteWatchedPaneIds(),
        });
        // One at a time: each reads the process table.
        for (const candidate of candidates) {
          await hibernateSessionIfSafe(candidate.sessionId, { reason: "idle" });
        }
      } catch (error) {
        logError("session.hibernation_check_failed", error);
      } finally {
        checking = false;
      }
    };
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);

    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, []);
}
