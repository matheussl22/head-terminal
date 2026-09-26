import { useMemo } from "react";

import {
  paneStatusTone,
  TONE_LABEL,
  type PaneStatusTone,
} from "../../core/activity-display";
import {
  countTerminalStatuses,
  type TerminalStatusCounts,
} from "../../core/activity-utils";
import { collectPaneIds } from "../../core/session-layout";
import { useSessionStore } from "../../core/session-manager";
import { IconCheck } from "./Icons";

interface StatusDotProps {
  tone: PaneStatusTone;
  /** Tooltip. Defaults to the tone's label; null leaves it to the parent (a
   * chip whose own tooltip says more). */
  title?: string | null;
  className?: string;
}

/**
 * The one status glyph of the app — pane header, sidebar, toolbar. Every tone
 * has its own shape as well as its own color, so a grid of ten terminals
 * reads at a glance and nothing hinges on telling green from blue: working
 * sends out a ring, waiting is solid with a halo, done is a check mark, error
 * an "!", the shell left behind by a crashed agent a diamond, idle and exited
 * are hollow, a session never started is dashed and starting spins.
 */
export function StatusDot({ tone, title, className }: StatusDotProps) {
  return (
    <span
      className={`status-dot status-dot--${tone}${className ? ` ${className}` : ""}`}
      title={title === null ? undefined : (title ?? TONE_LABEL[tone])}
      aria-hidden
    >
      {tone === "done" && <IconCheck size={11} className="status-dot__check" />}
      {tone === "error" && <span className="status-dot__mark">!</span>}
    </span>
  );
}

export type { TerminalStatusCounts };

/**
 * How many terminals, across every started session, are blocked on the user,
 * still working, or finished unseen (see countTerminalStatuses — the window
 * title and the close confirmation count the same way). The selector returns
 * a string so a context-percent ping somewhere doesn't re-render whoever
 * shows the counts.
 */
export function useTerminalStatusCounts(): TerminalStatusCounts {
  const key = useSessionStore((state) => {
    const { waiting, working, done } = countTerminalStatuses(
      state.sessions,
      state.paneRuntime,
      state.spawnedSessionIds,
    );
    return `${waiting}|${working}|${done}`;
  });
  return useMemo(() => {
    const [waiting, working, done] = key.split("|").map(Number);
    return { waiting, working, done };
  }, [key]);
}

/** The first terminal in `tone`, in sidebar order, to jump to it. */
export function findFirstPaneInTone(
  tone: PaneStatusTone,
): { sessionId: string; paneId: string } | null {
  const state = useSessionStore.getState();
  for (const session of state.sessions) {
    if (!state.spawnedSessionIds[session.id]) {
      continue;
    }
    for (const paneId of collectPaneIds(session.layout)) {
      if (paneStatusTone(state.paneRuntime[paneId]) === tone) {
        return { sessionId: session.id, paneId };
      }
    }
  }
  return null;
}
