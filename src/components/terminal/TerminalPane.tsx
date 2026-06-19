import { useRef, type CSSProperties } from "react";

import { loadPaneHeadersEnabled } from "../../core/ui-preferences";
import { useAgentSession } from "../../hooks/useAgentSession";
import {
  TerminalPaneHeader,
  TerminalPaneOverlay,
} from "./TerminalPaneChrome";

interface TerminalPaneProps {
  paneId: string;
  sessionId: string;
  cwd: string;
  agentProfileId: string;
  isVisible: boolean;
  shouldSpawn: boolean;
  isActive: boolean;
  paneIndex: number;
  paneCount: number;
  layoutStyle?: CSSProperties;
  onFocus: () => void;
}

export function TerminalPane({
  paneId,
  sessionId,
  cwd,
  agentProfileId,
  isVisible,
  shouldSpawn,
  isActive,
  paneIndex,
  paneCount,
  layoutStyle,
  onFocus,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const showHeader = loadPaneHeadersEnabled();

  useAgentSession({
    paneId,
    sessionId,
    cwd,
    agentProfileId,
    isVisible,
    shouldSpawn,
    containerRef,
  });

  return (
    <div
      className={
        isActive
          ? "terminal-pane-shell terminal-pane-shell--active terminal-pane--positioned"
          : "terminal-pane-shell terminal-pane--positioned"
      }
      style={layoutStyle}
    >
      {showHeader && (
        <TerminalPaneHeader
          paneId={paneId}
          paneIndex={paneIndex}
          paneCount={paneCount}
          isActive={isActive}
          onFocus={onFocus}
        />
      )}

      <div className="terminal-pane-shell__body">
        <div
          ref={containerRef}
          className={
            isActive ? "terminal-pane terminal-pane--active" : "terminal-pane"
          }
          tabIndex={0}
          role="application"
          aria-label="Terminal do agent"
          onMouseDown={onFocus}
        />
        <TerminalPaneOverlay
          paneId={paneId}
          paneIndex={paneIndex}
          paneCount={paneCount}
        />
      </div>
    </div>
  );
}
