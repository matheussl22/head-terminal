import { useEffect, useState } from "react";

import { fitPanes } from "../core/pane-fit-registry";
import { collectPaneIds } from "../core/session-layout";
import { useSessionStore } from "../core/session-manager";
import { closePaneWithWorktreeReview } from "../core/worktree";
import {
  notifyPaneDone,
  notifySessionStatus,
  paneDoneNotifications,
  pruneSessionNotifications,
  sessionNotification,
} from "../core/notifications";
import { revealPane, toggleActivePaneMinimized } from "../core/pane-minimize";
import { hasPrimaryModifier } from "../core/shortcuts";
import { forEachTerminal } from "../core/terminal-registry";
import {
  loadFontSize,
  saveFontSize,
} from "../core/ui-preferences";
import { toggleVoiceInput } from "../core/voice-input";

const NOTIFY_DEBOUNCE_MS = 300;
/** How long coming back to the window waits before reading the focused pane
 * as seen: a notification click may be what brought it back, and it names
 * another pane (see onActivated below). */
const SEEN_ON_RETURN_DELAY_MS = 250;

export function useActivityNotifications(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = () => {
      timer = null;
      const { sessions, activeSessionId, paneRuntime, spawnedSessionIds } =
        useSessionStore.getState();
      const windowFocused = document.hasFocus();
      const finishedPaneIds = new Set<string>();
      for (const session of sessions) {
        const paneIds = collectPaneIds(session.layout);
        const options = { spawned: Boolean(spawnedSessionIds[session.id]) };
        const notification = sessionNotification(
          session.title,
          paneIds,
          paneRuntime,
          options,
        );
        notifySessionStatus(session.id, notification, {
          sessionActive: session.id === activeSessionId,
          windowFocused,
        });
        // Every finished turn is its own news: a sibling still working (or
        // waiting) no longer holds back "api: cc3 concluiu".
        for (const done of paneDoneNotifications(session, paneIds, paneRuntime, options)) {
          finishedPaneIds.add(done.paneId);
          notifyPaneDone(session.id, done, { windowFocused });
        }
      }
      pruneSessionNotifications(
        new Set(sessions.map((session) => session.id)),
        finishedPaneIds,
      );
    };

    // Coming back to the window is looking at the pane it left focused: a
    // turn that ended there meanwhile is no longer news. The store checks it
    // is really in view — the window in front, the pane not in the dock nor
    // parked behind a zoomed sibling. Not right away, though: a click on a
    // notification brings the window back before it says which pane it is
    // about (macOS activates the app first), and the pane that was focused
    // until then — maybe in another session — was never looked at.
    let seenTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelMarkSeen = () => {
      if (seenTimer !== null) {
        clearTimeout(seenTimer);
        seenTimer = null;
      }
    };
    const markActivePaneSeen = () => {
      cancelMarkSeen();
      seenTimer = setTimeout(() => {
        seenTimer = null;
        useSessionStore.getState().markActivePaneSeen();
      }, SEEN_ON_RETURN_DELAY_MS);
    };
    window.addEventListener("focus", markActivePaneSeen);
    document.addEventListener("visibilitychange", markActivePaneSeen);

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
    const unsubscribeActivation = window.headTerminal.notifications.onActivated(
      ({ sessionId, paneId }) => {
        const state = useSessionStore.getState();
        const session = state.sessions.find((candidate) => candidate.id === sessionId);
        if (!session) {
          return;
        }
        // What the user looks at now is what the click brings on screen, and
        // that pane's "Concluído" is read as it is shown — not the one the
        // window had focused before.
        cancelMarkSeen();
        // "cc3 concluiu" should land on cc3 — out of the dock or from behind a
        // zoomed sibling if need be — not just somewhere in its session.
        if (paneId && collectPaneIds(session.layout).includes(paneId)) {
          revealPane(paneId);
        } else {
          state.setActiveSessionId(sessionId);
        }
      },
    );

    return () => {
      unsubscribe();
      unsubscribeActivation();
      window.removeEventListener("focus", markActivePaneSeen);
      document.removeEventListener("visibilitychange", markActivePaneSeen);
      cancelMarkSeen();
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, []);
}

export function useKeyboardShortcuts(options: {
  onCreateSession: () => void;
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
  const toggleMaximizedActivePane = useSessionStore(
    (state) => state.toggleMaximizedActivePane,
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement;
      // Ctrl on Windows/Linux, ⌘ on macOS. Only Ctrl+Tab below stays on
      // Control everywhere: ⌘Tab is the system's app switcher.
      const mod = hasPrimaryModifier(event);

      if (mod && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        options.onCommandPalette();
        return;
      }

      if (mod && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        options.onCreateSession();
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

      if (!isInput && mod && event.key.toLowerCase() === "f") {
        event.preventDefault();
        options.onSearch();
        return;
      }

      if (!isInput && mod && (event.key === "=" || event.key === "+")) {
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

      if (!isInput && mod && event.key === "-") {
        event.preventDefault();
        const next = loadFontSize() - 1;
        saveFontSize(next);
        forEachTerminal((_paneId, handle) => {
          handle.terminal.options.fontSize = next;
        });
        fitPanes(useSessionStore.getState().getTargetPaneIds());
        return;
      }

      if (!isInput && mod && event.key === "0") {
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

      if (!isInput && mod && event.key === "\\") {
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
        mod &&
        event.shiftKey &&
        event.key.toLowerCase() === "z"
      ) {
        event.preventDefault();
        toggleMaximizedActivePane();
        return;
      }

      // xterm turns Ctrl+letter into a control character (Ctrl+M is Enter),
      // but not with Shift held: this reaches here without typing anything.
      // And it arrives from xterm's own textarea, where the keyboard sits
      // nearly all the time — that one is the terminal, not a text field.
      const fromTerminal =
        target instanceof HTMLTextAreaElement &&
        target.classList.contains("xterm-helper-textarea");
      if (
        (!isInput || fromTerminal) &&
        mod &&
        event.shiftKey &&
        event.key.toLowerCase() === "m"
      ) {
        event.preventDefault();
        toggleActivePaneMinimized();
        return;
      }

      if (
        !isInput &&
        mod &&
        event.shiftKey &&
        event.key.toLowerCase() === "w"
      ) {
        event.preventDefault();
        if (activePaneId) {
          void closePaneWithWorktreeReview(activePaneId);
        }
        return;
      }

      if (isInput) {
        return;
      }

      if (event.key === "Tab" && event.ctrlKey && !event.metaKey) {
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

      if (!mod || (event.ctrlKey && event.metaKey)) {
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
    options,
    sessions,
    setActiveSessionId,
    splitActivePane,
    toggleMaximizedActivePane,
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
