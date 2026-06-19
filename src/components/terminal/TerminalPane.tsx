import { useRef, type CSSProperties } from "react";

import { useAgentSession } from "../../hooks/useAgentSession";

interface TerminalPaneProps {
  paneId: string;
  sessionId: string;
  cwd: string;
  agentProfileId: string;
  isVisible: boolean;
  isActive: boolean;
  layoutStyle?: CSSProperties;
  onFocus: () => void;
}

export function TerminalPane({
  paneId,
  sessionId,
  cwd,
  agentProfileId,
  isVisible,
  isActive,
  layoutStyle,
  onFocus,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useAgentSession({
    paneId,
    sessionId,
    cwd,
    agentProfileId,
    isVisible,
    containerRef,
  });

  return (
    <div
      ref={containerRef}
      className={
        isActive
          ? "terminal-pane terminal-pane--positioned terminal-pane--active"
          : "terminal-pane terminal-pane--positioned"
      }
      style={layoutStyle}
      tabIndex={0}
      role="application"
      aria-label="Terminal do agent"
      onMouseDown={onFocus}
    />
  );
}
