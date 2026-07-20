import { useRef, useState, type CSSProperties } from "react";

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
  isVisible: boolean;
  shouldSpawn: boolean;
  isActive: boolean;
  paneIndex: number;
  paneCount: number;
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
  isVisible,
  shouldSpawn,
  isActive,
  paneIndex,
  paneCount,
  layoutStyle,
  searchOpen,
  onCloseSearch,
  onFocus,
  onClose,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const showHeader = loadPaneHeadersEnabled();
  const [searchQuery, setSearchQuery] = useState("");

  useAgentSession({
    paneId,
    sessionId,
    cwd,
    agentProfileId,
    claudeAccountId,
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
