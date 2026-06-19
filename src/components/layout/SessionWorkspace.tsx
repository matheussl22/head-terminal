import { useMemo } from "react";

import {
  collectPaneIds,
  collectPaneRects,
  collectSplitDividers,
} from "../../core/session-layout";
import { useSessionStore } from "../../core/session-manager";
import type { AgentSession } from "../../types/session";
import { LayoutDividers } from "./LayoutDividers";
import { TerminalPane } from "../terminal/TerminalPane";

interface SessionWorkspaceProps {
  session: AgentSession;
  isVisible: boolean;
}

export function SessionWorkspace({ session, isVisible }: SessionWorkspaceProps) {
  const activePaneId = useSessionStore((state) => state.activePaneId);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const setActivePaneId = useSessionStore((state) => state.setActivePaneId);
  const setActiveSessionId = useSessionStore((state) => state.setActiveSessionId);

  const paneRects = useMemo(
    () => collectPaneRects(session.layout),
    [session.layout],
  );
  const dividers = useMemo(
    () => collectSplitDividers(session.layout),
    [session.layout],
  );
  const paneIds = useMemo(
    () => collectPaneIds(session.layout),
    [session.layout],
  );

  const focusPane = (paneId: string) => {
    setActiveSessionId(session.id);
    setActivePaneId(paneId);
  };

  return (
    <section
      className={
        isVisible
          ? "session-workspace session-workspace--visible"
          : "session-workspace session-workspace--hidden"
      }
      aria-hidden={!isVisible}
    >
      <div className="session-workspace__canvas">
        {paneIds.map((paneId) => {
          const rect = paneRects.find((item) => item.paneId === paneId);
          const isActive =
            session.id === activeSessionId && paneId === activePaneId;

          return (
            <TerminalPane
              key={paneId}
              paneId={paneId}
              sessionId={session.id}
              cwd={session.cwd}
              agentProfileId={session.agentProfileId}
              isVisible={isVisible}
              isActive={isActive}
              layoutStyle={
                rect
                  ? {
                      top: `${rect.top}%`,
                      left: `${rect.left}%`,
                      width: `${rect.width}%`,
                      height: `${rect.height}%`,
                    }
                  : undefined
              }
              onFocus={() => focusPane(paneId)}
            />
          );
        })}

        <LayoutDividers sessionId={session.id} dividers={dividers} />
      </div>
    </section>
  );
}
