import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { paneStatusTone } from "../../core/activity-display";
import { landPaneMotion } from "../../core/pane-minimize";
import { useSessionStore } from "../../core/session-manager";
import { loadPaneHeadersEnabled } from "../../core/ui-preferences";
import { getTerminal } from "../../core/terminal-registry";
import { useAgentSession } from "../../hooks/useAgentSession";
import { SearchBar } from "./SearchBar";
import {
  TerminalPaneHeader,
  TerminalPaneOverlay,
} from "./TerminalPaneChrome";

interface TerminalPaneProps {
  paneId: string;
  sessionId: string;
  cwd: string;
  agentProfileId: string;
  claudeAccountId?: string;
  ollamaModel?: string;
  ollamaThinkOff?: boolean;
  ggufPath?: string;
  wslDistro?: string;
  isVisible: boolean;
  shouldSpawn: boolean;
  isActive: boolean;
  /** Off the canvas but live: another pane is maximized, or this one is
   * minimized. */
  isParked: boolean;
  /** In the session's dock (see MinimizedPaneDock). */
  isMinimized: boolean;
  isMaximized: boolean;
  paneIndex: number;
  paneCount: number;
  /** Panes of the session on the canvas, i.e. not minimized. */
  onScreenPaneCount: number;
  layoutStyle?: CSSProperties;
  searchOpen: boolean;
  onCloseSearch: () => void;
  onFocus: () => void;
  onClose: () => void;
}

export function TerminalPane({
  paneId,
  sessionId,
  cwd,
  agentProfileId,
  claudeAccountId,
  ollamaModel,
  ollamaThinkOff,
  ggufPath,
  wslDistro,
  isVisible,
  shouldSpawn,
  isActive,
  isParked,
  isMinimized,
  isMaximized,
  paneIndex,
  paneCount,
  onScreenPaneCount,
  layoutStyle,
  searchOpen,
  onCloseSearch,
  onFocus,
  onClose,
}: TerminalPaneProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wasMinimizedRef = useRef(isMinimized);
  const showHeader = loadPaneHeadersEnabled();
  const [searchQuery, setSearchQuery] = useState("");
  // The frame itself carries the tone, so a pane blocked on the user stands
  // out in a crowded grid even with its header hidden or squeezed to a dot.
  const tone = useSessionStore((state) => paneStatusTone(state.paneRuntime[paneId]));

  // A minimized terminal must not keep the keyboard: typing would land in an
  // agent nobody can see. Child effects run before AppShell's, which then
  // hands the focus to the pane that became active, if any is left.
  useEffect(() => {
    const focused = document.activeElement;
    if (
      isMinimized &&
      focused instanceof HTMLElement &&
      shellRef.current?.contains(focused)
    ) {
      focused.blur();
    }
  }, [isMinimized]);

  // Back from the dock: fly in from the card, and take the keyboard — the
  // pane may already have been the active one, so AppShell won't refocus.
  useLayoutEffect(() => {
    const wasMinimized = wasMinimizedRef.current;
    wasMinimizedRef.current = isMinimized;
    if (!wasMinimized || isMinimized) {
      return;
    }
    landPaneMotion(paneId, "restore", shellRef.current);
    if (useSessionStore.getState().activePaneId === paneId) {
      requestAnimationFrame(() => getTerminal(paneId)?.terminal.focus());
    }
  }, [isMinimized, paneId]);

  useAgentSession({
    paneId,
    sessionId,
    cwd,
    agentProfileId,
    claudeAccountId,
    ollamaModel,
    ollamaThinkOff,
    ggufPath,
    wslDistro,
    isVisible,
    shouldSpawn,
    containerRef,
  });

  const shellClasses = [
    "terminal-pane-shell",
    "terminal-pane--positioned",
    isActive ? "terminal-pane-shell--active" : null,
    isMaximized ? "terminal-pane-shell--maximized" : null,
    isParked ? "terminal-pane-shell--parked" : null,
    `terminal-pane-shell--tone-${tone}`,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={shellRef}
      className={shellClasses}
      style={layoutStyle}
      aria-hidden={isParked}
      data-pane-shell={paneId}
    >
      {showHeader && (
        <TerminalPaneHeader
          paneId={paneId}
          sessionId={sessionId}
          cwd={cwd}
          agentProfileId={agentProfileId}
          claudeAccountId={claudeAccountId}
          paneIndex={paneIndex}
          paneCount={paneCount}
          onScreenPaneCount={onScreenPaneCount}
          isActive={isActive}
          isMaximized={isMaximized}
          onScreen={isVisible && !isParked}
          onFocus={onFocus}
          onClose={onClose}
        />
      )}

      <div className="terminal-pane-shell__body">
        {searchOpen && (
          <SearchBar
            query={searchQuery}
            onQueryChange={(query) => {
              setSearchQuery(query);
              getTerminal(paneId)?.searchAddon?.findNext(query, {
                caseSensitive: false,
              });
            }}
            onNext={() => {
              getTerminal(paneId)?.searchAddon?.findNext(searchQuery, {
                caseSensitive: false,
              });
            }}
            onPrevious={() => {
              getTerminal(paneId)?.searchAddon?.findPrevious(searchQuery, {
                caseSensitive: false,
              });
            }}
            onClose={() => {
              setSearchQuery("");
              onCloseSearch();
            }}
          />
        )}
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
