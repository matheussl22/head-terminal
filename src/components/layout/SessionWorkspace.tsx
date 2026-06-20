import { memo, useEffect, useMemo, useRef } from "react";

import {
  collectPaneIds,
  collectPaneRects,
  collectSplitDividers,
} from "../../core/session-layout";
import { debounce } from "../../core/debounce";
import { fitPanes } from "../../core/pane-fit-registry";
import { useSessionStore } from "../../core/session-manager";
import type { AgentSession } from "../../types/session";
import { TerminalStatusBar } from "../terminal/TerminalStatusBar";
import { LayoutDividers } from "./LayoutDividers";
import { TerminalPane } from "../terminal/TerminalPane";

interface SessionWorkspaceProps {
  session: AgentSession;
  isVisible: boolean;
  shouldSpawn: boolean;
}

export const SessionWorkspace = memo(function SessionWorkspace({
  session,
  isVisible,
  shouldSpawn,
}: SessionWorkspaceProps) {
  const activePaneId = useSessionStore((state) => state.activePaneId);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const setActivePaneId = useSessionStore((state) => state.setActivePaneId);
  const setActiveSessionId = useSessionStore((state) => state.setActiveSessionId);

  const canvasRef = useRef<HTMLDivElement>(null);

  const paneRects = useMemo(
    () => collectPaneRects(session.layout),
    [session.layout],
  );
  const paneRectById = useMemo(
    () => new Map(paneRects.map((rect) => [rect.paneId, rect])),
    [paneRects],
  );
  const dividers = useMemo(
    () => collectSplitDividers(session.layout),
    [session.layout],
  );
  const paneIds = useMemo(
    () => collectPaneIds(session.layout),
    [session.layout],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !shouldSpawn) {
      return;
    }

    const debouncedFit = debounce(() => fitPanes(paneIds), 120);
    const resizeObserver = new ResizeObserver(() => {
      debouncedFit();
    });
    resizeObserver.observe(canvas);

    return () => {
      resizeObserver.disconnect();
      debouncedFit.cancel();
    };
  }, [paneIds, shouldSpawn]);

  const focusPane = (paneId: string) => {
    setActiveSessionId(session.id);
    setActivePaneId(paneId);
  };

  if (!shouldSpawn) {
    return null;
  }

  return (
    <section
      className={
        isVisible
          ? "session-workspace session-workspace--visible fade-in"
          : "session-workspace session-workspace--hidden"
      }
      aria-hidden={!isVisible}
    >
      <div ref={canvasRef} className="session-workspace__canvas">
        {paneIds.map((paneId, index) => {
          const rect = paneRectById.get(paneId);
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
              shouldSpawn={shouldSpawn}
              isActive={isActive}
              paneIndex={index}
              paneCount={paneIds.length}
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
      <TerminalStatusBar sessionId={session.id} />
    </section>
  );
});
