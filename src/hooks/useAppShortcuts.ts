import { useEffect, useState } from "react";

import { getSessionActivity } from "../core/activity-utils";
import { fitPanes } from "../core/pane-fit-registry";
import { useSessionStore } from "../core/session-manager";
import { notifySessionAttention } from "../core/notifications";
import { forEachTerminal } from "../core/terminal-registry";
import {
  loadFontSize,
  saveFontSize,
} from "../core/ui-preferences";
import { toggleVoiceInput } from "../core/voice-input";

const NOTIFY_DEBOUNCE_MS = 300;

export function useActivityNotifications(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = () => {
      timer = null;
      const { sessions, activeSessionId, paneRuntime } =
        useSessionStore.getState();
      for (const session of sessions) {
        if (session.id === activeSessionId && document.hasFocus()) {
          continue;
        }

        const activity = getSessionActivity(session, paneRuntime);
        void notifySessionAttention(session.title, activity, session.id);
      }
    };

    // Store subscription instead of a React render dependency: activity
    // ticks are frequent and shouldn't re-render the shell tree.
    const unsubscribe = useSessionStore.subscribe((state, previous) => {
      if (state.paneRuntime === previous.paneRuntime) {
        return;
      }
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(check, NOTIFY_DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, []);
}

export function useKeyboardShortcuts(options: {
  onCommandPalette: () => void;
  onRenameSession: () => void;
  onSearch: () => void;
  onCloseSearch: () => void;
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

      if (event.key === "F9") {
        event.preventDefault();
        const paneId = useSessionStore.getState().activePaneId;
        if (paneId) {
          void toggleVoiceInput(paneId);
        }
        return;
      }

      if (!isInput && event.ctrlKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        options.onSearch();
        return;
      }

      if (!isInput && event.ctrlKey && (event.key === "=" || event.key === "+")) {
        event.preventDefault();
        const next = loadFontSize() + 1;
        saveFontSize(next);
        forEachTerminal((_paneId, handle) => {
          handle.terminal.options.fontSize = next;
        });
        const paneIds = useSessionStore
          .getState()
          .getTargetPaneIds();
        fitPanes(paneIds);
        return;
      }

      if (!isInput && event.ctrlKey && event.key === "-") {
        event.preventDefault();
        const next = loadFontSize() - 1;
        saveFontSize(next);
        forEachTerminal((_paneId, handle) => {
          handle.terminal.options.fontSize = next;
        });
        fitPanes(useSessionStore.getState().getTargetPaneIds());
        return;
      }

      if (!isInput && event.ctrlKey && event.key === "0") {
        event.preventDefault();
        saveFontSize(12);
        forEachTerminal((_paneId, handle) => {
          handle.terminal.options.fontSize = 12;
        });
        fitPanes(useSessionStore.getState().getTargetPaneIds());
        return;
      }

      if (event.key === "Escape") {
        options.onCloseSearch();
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
