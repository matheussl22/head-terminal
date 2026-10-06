import { useEffect, useMemo, useState } from "react";

import { fitPanes } from "../core/pane-fit-registry";
import { isMacHost } from "../core/platform-info";
import { collectPaneIds } from "../core/session-layout";
import {
  isPaneOnScreen,
  sessionsInView,
  useSessionStore,
} from "../core/session-manager";
import { closePaneWithWorktreeReview } from "../core/worktree";
import {
  notifyPaneDone,
  notifySessionStatus,
  paneDoneNotifications,
  pruneSessionNotifications,
  sessionNotification,
} from "../core/notifications";
import { revealPane, toggleActivePaneMinimized } from "../core/pane-minimize";
import { hasPrimaryModifier, splitShortcutDirection } from "../core/shortcuts";
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

const PANE_FOCUS_KEYS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowUp: -1,
  ArrowRight: 1,
  ArrowDown: 1,
};

/**
 * Hands the keyboard to the pane before or after the active one among those
 * on screen in its session, wrapping around like VS Code's split terminals.
 * False when there is no other pane to go to.
 */
function focusSiblingPane(delta: number): boolean {
  const state = useSessionStore.getState();
  const session = state.sessions.find((item) => item.id === state.activeSessionId);
  if (!session || !state.activePaneId) {
    return false;
  }
  const paneIds = collectPaneIds(session.layout).filter((paneId) =>
    isPaneOnScreen(state, paneId),
  );
  const index = paneIds.indexOf(state.activePaneId);
  if (paneIds.length < 2 || index < 0) {
    return false;
  }
  state.setActivePaneId(paneIds[(index + delta + paneIds.length) % paneIds.length]);
  return true;
}

export function useKeyboardShortcuts(options: {
  onCreateSession: () => void;
  onCommandPalette: () => void;
  onRenameSession: () => void;
  onSearch: () => void;
  onCloseSearch: () => void;
}): void {
  const allSessions = useSessionStore((state) => state.sessions);
  const projectsEnabled = useSessionStore((state) => state.projectsEnabled);
  const projectsView = useSessionStore((state) => state.projectsView);
  const projects = useSessionStore((state) => state.projects);
  const activeProjectId = useSessionStore((state) => state.activeProjectId);
  // ⌘1–9, Ctrl+Tab and ⌘⇧[ / ⌘⇧] go through the sessions the sidebar shows,
  // in its order: in projects mode only the project on screen, or the
  // unfolded projects of the grouped view.
  const sessions = useMemo(
    () =>
      sessionsInView({
        sessions: allSessions,
        projectsEnabled,
        projectsView,
        projects,
        activeProjectId,
      }),
    [activeProjectId, allSessions, projects, projectsEnabled, projectsView],
  );
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const setActiveSessionId = useSessionStore((state) => state.setActiveSessionId);
  const splitActivePane = useSessionStore((state) => state.splitActivePane);
  const activePaneId = useSessionStore((state) => state.activePaneId);
  const toggleMaximizedActivePane = useSessionStore(
    (state) => state.toggleMaximizedActivePane,
  );

  useEffect(() => {
    const cycleSession = (delta: number) => {
      if (sessions.length < 2) {
        return;
      }
      const currentIndex = sessions.findIndex(
        (session) => session.id === activeSessionId,
      );
      const nextIndex =
        (currentIndex + delta + sessions.length) % sessions.length;
      setActiveSessionId(sessions[nextIndex].id);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      // A text field of the app's own UI. xterm's helper textarea is not one:
      // it is the terminal, and search, zoom and the session keys below work
      // from a focused pane too.
      const isInput =
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement) &&
        !target.classList.contains("xterm-helper-textarea");
      // Ctrl on Windows/Linux, ⌘ on macOS. Only Ctrl+Tab below stays on
      // Control everywhere: ⌘Tab is the system's app switcher. Never both:
      // ⌃⌘F is the menu's full screen, not search.
      const mod = hasPrimaryModifier(event) && !(event.ctrlKey && event.metaKey);

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

      // The pane shortcuts arrive from xterm's own textarea, where the
      // keyboard sits nearly all the time — that one is the terminal, not a
      // text field. They reach here without typing anything: xterm turns
      // Ctrl+letter into a control character (Ctrl+M is Enter) but not with
      // Shift held, hands ⌘ combinations on, and lets Ctrl+\ through (see
      // createConfiguredTerminal). Handled, they must be prevented too: on
      // macOS a ⌘ key the page leaves alone goes on to the menu, and ⌘⇧Z
      // there is Edit › Redo.
      const fromTerminal =
        target instanceof HTMLTextAreaElement &&
        target.classList.contains("xterm-helper-textarea");
      // Alt stays out of them: AltGr arrives as Ctrl+Alt on Windows.
      const paneShortcut =
        (!isInput || fromTerminal) && mod && !event.altKey && event.shiftKey;

      const split = splitShortcutDirection(event);
      if ((!isInput || fromTerminal) && split) {
        event.preventDefault();
        splitActivePane(split);
        return;
      }

      if (paneShortcut && event.key.toLowerCase() === "z") {
        event.preventDefault();
        toggleMaximizedActivePane();
        return;
      }

      if (paneShortcut && event.key.toLowerCase() === "m") {
        event.preventDefault();
        toggleActivePaneMinimized();
        return;
      }

      if (paneShortcut && event.key.toLowerCase() === "w") {
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
        cycleSession(event.shiftKey ? -1 : 1);
        return;
      }

      // VS Code's terminal on macOS: ⌘⇧[ / ⌘⇧] go to the previous / next
      // terminal — a session here — and ⌥⌘ with an arrow to the previous /
      // next split pane.
      if (isMacHost() && event.metaKey && !event.ctrlKey) {
        if (
          event.shiftKey &&
          !event.altKey &&
          (event.code === "BracketLeft" || event.code === "BracketRight")
        ) {
          event.preventDefault();
          cycleSession(event.code === "BracketLeft" ? -1 : 1);
          return;
        }
        const paneDelta = PANE_FOCUS_KEYS[event.key];
        if (event.altKey && !event.shiftKey && paneDelta && focusSiblingPane(paneDelta)) {
          event.preventDefault();
          return;
        }
      }

      if (!mod) {
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
