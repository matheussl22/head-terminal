import { create } from "zustand";

import type { PaneActivity } from "../types/activity";
import {
  closePaneInLayout,
  collectPaneIds,
  createInitialLayout,
  createPaneId,
  findPaneNode,
  mapPaneNodes,
  resolvePaneCwd,
  setPaneCwdInLayout,
  splitPaneInLayout,
  updateSplitRatioInLayout,
} from "./session-layout";
import {
  flushPersistedWorkspace,
  schedulePersistedWorkspace,
  workspaceFromStore,
} from "./session-persistence";
import { logEvent } from "./logger";
import { gitContextsEqual } from "./git-context-utils";
import {
  loadRunEverything,
  saveRunEverything,
} from "./ui-preferences";
import type { GitContext } from "../types/git-context";
import type { AgentSession, SessionStatus, SplitDirection } from "../types/session";

export interface PaneRuntime {
  status: SessionStatus;
  activity: PaneActivity;
  activitySince: number;
  restartAttempts: number;
  /** % de contexto restante reportado pelo agent no output (0-100). */
  contextPercent?: number;
}

/** Custom conversation names are keyed by CLI session id, and those ids are
 * never reused, so the map would otherwise grow for the life of the app.
 * Object key order is insertion order, so the oldest entries drop first. */
const MAX_CONVERSATION_LABELS = 500;
export const CONVERSATION_LABEL_MAX_LENGTH = 120;

function pruneConversationLabels(
  labels: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(labels);
  if (entries.length <= MAX_CONVERSATION_LABELS) {
    return labels;
  }
  return Object.fromEntries(entries.slice(-MAX_CONVERSATION_LABELS));
}

function normalizeConversationLabel(label: string): string {
  return label.replace(/\s+/gu, " ").trim().slice(0, CONVERSATION_LABEL_MAX_LENGTH);
}

export function createPaneRuntime(): PaneRuntime {
  return {
    status: "starting",
    activity: "starting",
    activitySince: Date.now(),
    restartAttempts: 0,
  };
}

interface SessionStore {
  sessions: AgentSession[];
  activeSessionId: string | null;
  activePaneId: string | null;
  paneRestartKeys: Record<string, number>;
  paneRuntime: Record<string, PaneRuntime>;
  ptyWriters: Record<string, (data: string) => void>;
  voiceRecordingPaneId: string | null;
  voiceTranscribingPaneId: string | null;
  runEverything: boolean;
  spawnedSessionIds: Record<string, boolean>;
  restoredPaneIds: Record<string, boolean>;
  /** CLI session id to resume, set only via `resumePane` (dropdown pick). */
  paneResumeSessionIds: Record<string, string>;
  /** paneId -> last known CLI session id, persisted across app restarts so
   * `hydrateWorkspace` can `--resume` each pane's own conversation instead
   * of a blanket `--continue` that collides whenever panes share a cwd. */
  paneResumeAnchors: Record<string, string>;
  /** CLI session id -> name the user gave that conversation. Persisted, so a
   * conversation keeps its name across restarts and in the resume dropdown. */
  conversationLabels: Record<string, string>;
  /** CLI session id -> title derived from the agent's transcript. Cache only:
   * refilled from disk on demand, never persisted. */
  conversationTitles: Record<string, string>;
  /** paneId -> name typed before the pane's CLI session id was known. Promoted
   * onto `conversationLabels` as soon as the anchor shows up. */
  pendingConversationLabels: Record<string, string>;
  sessionGitContext: Record<string, GitContext>;
  paneGitContext: Record<string, GitContext>;
  addSession: (session: AgentSession) => void;
  hydrateWorkspace: (
    sessions: AgentSession[],
    activeSessionId: string | null,
    activePaneId: string | null,
    paneResumeAnchors?: Record<string, string>,
    conversationLabels?: Record<string, string>,
  ) => void;
  setActiveSessionId: (sessionId: string) => void;
  setActivePaneId: (paneId: string) => void;
  renameSession: (sessionId: string, title: string) => void;
  updateSessionAgent: (sessionId: string, agentProfileId: string) => void;
  updateSessionCwd: (sessionId: string, cwd: string) => void;
  /** Moves one terminal to another folder and restarts only that terminal.
   * The session's own `cwd` stays the default for the other panes. */
    updatePaneCwd: (paneId: string, cwd: string) => void;
  setRunEverything: (enabled: boolean) => void;
  removeSession: (sessionId: string) => void;
  reorderSessions: (fromIndex: number, toIndex: number) => void;
  togglePinSession: (sessionId: string) => void;
  splitActivePane: (direction: SplitDirection) => void;
  /** Split this exact pane, whichever session it belongs to. The pane header
   * offers it so the user divides the terminal under the cursor, not
   * whichever one happens to hold focus. */
  splitPane: (paneId: string, direction: SplitDirection) => void;
  closePane: (paneId: string) => void;
  updateSplitRatio: (
    sessionId: string,
    path: number[],
    ratio: number,
    options?: { persist?: boolean },
  ) => void;
  restartPane: (
    paneId: string,
    options?: { continueConversation?: boolean },
  ) => void;
  resumePane: (paneId: string, sessionId: string) => void;
  /** Best-effort auto-detected anchor (see pane-resume-anchor.ts) — records
   * which CLI session id a pane's conversation actually landed on, without
   * forcing an immediate --resume the way `resumePane` does. */
  notePaneResumeAnchor: (paneId: string, sessionId: string) => void;
  /** Drops a pane's anchor without restarting it — for when the CLI refused
   * to resume that conversation, so neither the header nor the next app
   * launch should keep pointing at it. */
  clearPaneResumeAnchor: (paneId: string) => void;
  /** Renames one CLI conversation by its id (an entry of the resume list).
   * An empty name clears the custom label and falls back to the transcript
   * title. */
  setConversationLabel: (cliSessionId: string, label: string) => void;
  /** Renames whatever conversation a pane is on. Before the pane's CLI
   * session id is known the name is parked on the pane and promoted later,
   * so naming a just-spawned conversation is never rejected. */
  setPaneConversationLabel: (paneId: string, label: string) => void;
  /** Feeds the transcript-title cache from a resume-list lookup. */
  noteConversationTitles: (
    entries: Array<{ id: string; title: string }>,
  ) => void;
  restartTargetPanes: () => void;
  restartSessionPanes: (sessionId: string) => void;
  updatePaneStatus: (paneId: string, status: SessionStatus) => void;
  updatePaneActivity: (paneId: string, activity: PaneActivity) => void;
  updatePaneContext: (paneId: string, contextPercent: number) => void;
  registerPtyWriter: (paneId: string, write: (data: string) => void) => void;
  unregisterPtyWriter: (paneId: string) => void;
  setVoiceRecordingPaneId: (paneId: string | null) => void;
  setVoiceTranscribingPaneId: (paneId: string | null) => void;
  setSessionGitContext: (sessionId: string, context: GitContext) => void;
  mergeSessionGitContext: (
    sessionId: string,
    partial: Partial<GitContext>,
  ) => void;
  setPaneGitContext: (paneId: string, context: GitContext) => void;
  mergePaneGitContext: (
    paneId: string,
    partial: Partial<GitContext>,
  ) => void;
  getActiveSession: () => AgentSession | null;
  getTargetPaneIds: () => string[];
}

function syncActivePane(
  session: AgentSession | null,
  currentPaneId: string | null,
): string | null {
  if (!session) {
    return null;
  }

  const paneIds = collectPaneIds(session.layout);
  if (currentPaneId && paneIds.includes(currentPaneId)) {
    return currentPaneId;
  }

  return paneIds[0] ?? null;
}

function sessionHasPane(session: AgentSession, paneId: string): boolean {
  return collectPaneIds(session.layout).includes(paneId);
}

function logSpawnState(
  event: string,
  sessionId: string | null,
  spawnedSessionIds: Record<string, boolean>,
  meta?: Record<string, unknown>,
): void {
  logEvent("info", event, {
    sessionId,
    spawned: sessionId ? Boolean(spawnedSessionIds[sessionId]) : false,
    spawnedSessionIds: Object.keys(spawnedSessionIds),
    ...meta,
  });
}

function checkpointSessionSpawn(sessionId: string | null): void {
  if (!sessionId) {
    return;
  }
  logEvent("info", "js.session.spawn_scheduled", { sessionId });
}

function persistWorkspaceState(
  state: SessionStore,
  options?: { immediate?: boolean },
): void {
  const workspace = workspaceFromStore({
    sessions: state.sessions,
    activeSessionId: state.activeSessionId,
    activePaneId: state.activePaneId,
    paneResumeSessionIds: state.paneResumeAnchors,
    conversationLabels: state.conversationLabels,
  });

  if (options?.immediate) {
    void flushPersistedWorkspace(workspace).catch(() => undefined);
    return;
  }

  schedulePersistedWorkspace(workspace);
}

function cleanupPaneState(
  state: SessionStore,
  paneIds: string[],
): Pick<
  SessionStore,
  | "paneRuntime"
  | "ptyWriters"
  | "paneRestartKeys"
  | "paneGitContext"
  | "paneResumeSessionIds"
  | "paneResumeAnchors"
  | "pendingConversationLabels"
> {
  const paneRuntime = { ...state.paneRuntime };
  const ptyWriters = { ...state.ptyWriters };
  const paneRestartKeys = { ...state.paneRestartKeys };
  const paneGitContext = { ...state.paneGitContext };
  const paneResumeSessionIds = { ...state.paneResumeSessionIds };
  const paneResumeAnchors = { ...state.paneResumeAnchors };
  const pendingConversationLabels = { ...state.pendingConversationLabels };

  for (const paneId of paneIds) {
    delete paneRuntime[paneId];
    delete ptyWriters[paneId];
    delete paneRestartKeys[paneId];
    delete paneGitContext[paneId];
    delete paneResumeSessionIds[paneId];
    delete paneResumeAnchors[paneId];
    delete pendingConversationLabels[paneId];
  }

  return {
    paneRuntime,
    ptyWriters,
    paneRestartKeys,
    paneGitContext,
    paneResumeSessionIds,
    paneResumeAnchors,
    pendingConversationLabels,
  };
}

function resetPaneRuntime(
  runtime: Record<string, PaneRuntime>,
  paneId: string,
): Record<string, PaneRuntime> {
  return {
    ...runtime,
    [paneId]: {
      ...(runtime[paneId] ?? createPaneRuntime()),
      status: "starting",
      activity: "starting",
      activitySince: Date.now(),
    },
  };
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  activePaneId: null,
  paneRestartKeys: {},
  paneRuntime: {},
  ptyWriters: {},
  voiceRecordingPaneId: null,
  voiceTranscribingPaneId: null,
  runEverything: loadRunEverything(),
  spawnedSessionIds: {},
  restoredPaneIds: {},
  paneResumeSessionIds: {},
  paneResumeAnchors: {},
  conversationLabels: {},
  conversationTitles: {},
  pendingConversationLabels: {},
  sessionGitContext: {},
  paneGitContext: {},

  addSession: (session) =>
    set((state) => {
      const paneIds = collectPaneIds(session.layout);
      const paneRuntime = { ...state.paneRuntime };
      for (const paneId of paneIds) {
        paneRuntime[paneId] = createPaneRuntime();
      }

      const next = {
        sessions: [...state.sessions, session],
        activeSessionId: session.id,
        activePaneId: paneIds[0] ?? null,
        paneRuntime,
        spawnedSessionIds: {
          ...state.spawnedSessionIds,
          [session.id]: true,
        },
      };
      persistWorkspaceState({ ...state, ...next }, { immediate: true });
      checkpointSessionSpawn(session.id);
      return next;
    }),

  hydrateWorkspace: (
    sessions,
    activeSessionId,
    activePaneId,
    paneResumeAnchors = {},
    conversationLabels = {},
  ) => {
    const paneRuntime: Record<string, PaneRuntime> = {};
    const restoredPaneIds: Record<string, boolean> = {};
    const paneResumeSessionIds: Record<string, string> = {};
    for (const session of sessions) {
      for (const paneId of collectPaneIds(session.layout)) {
        paneRuntime[paneId] = createPaneRuntime();
        const anchor = paneResumeAnchors[paneId];
        if (anchor) {
          // Precise: --resume this exact conversation, no collision even
          // when other panes share the same cwd.
          restoredPaneIds[paneId] = true;
          paneResumeSessionIds[paneId] = anchor;
        } else if (paneId === activePaneId) {
          // No anchor yet (first restart on this app version, or the
          // auto-detect race lost) — only the pane the user was last
          // looking at falls back to a blanket --continue. Every other
          // anchor-less pane starts fresh rather than risk several CLI
          // processes racing to append the same transcript file.
          restoredPaneIds[paneId] = true;
        }
      }
    }

    const spawnedSessionIds: Record<string, boolean> = {};
    if (activeSessionId) {
      spawnedSessionIds[activeSessionId] = true;
    }

    set({
      sessions,
      activeSessionId,
      activePaneId,
      paneRestartKeys: {},
      paneRuntime,
      ptyWriters: {},
      spawnedSessionIds,
      restoredPaneIds,
      paneResumeSessionIds,
      paneResumeAnchors,
      conversationLabels,
      conversationTitles: {},
      pendingConversationLabels: {},
    });
    logSpawnState(
      "session.spawn_state",
      activeSessionId,
      spawnedSessionIds,
      { source: "hydrate" },
    );
    checkpointSessionSpawn(activeSessionId);
    persistWorkspaceState({
      ...get(),
      sessions,
      activeSessionId,
      activePaneId,
    });
  },

  setActiveSessionId: (sessionId) =>
    set((state) => {
      const session = state.sessions.find((item) => item.id === sessionId) ?? null;
      const next = {
        activeSessionId: sessionId,
        activePaneId: syncActivePane(session, state.activePaneId),
        spawnedSessionIds: {
          ...state.spawnedSessionIds,
          [sessionId]: true,
        },
      };
      persistWorkspaceState({ ...state, ...next });
      logSpawnState("session.spawn_state", sessionId, next.spawnedSessionIds, {
        source: "activate",
      });
      checkpointSessionSpawn(sessionId);
      return next;
    }),

  setActivePaneId: (paneId) =>
    set((state) => {
      const next = { activePaneId: paneId };
      persistWorkspaceState({ ...state, ...next });
      return next;
    }),

  renameSession: (sessionId, title) =>
    set((state) => {
      const nextSessions = state.sessions.map((session) =>
        session.id === sessionId ? { ...session, title } : session,
      );
      const next = { sessions: nextSessions };
      persistWorkspaceState({ ...state, ...next });
      return next;
    }),

  updateSessionAgent: (sessionId, agentProfileId) => {
    const existing = get().sessions.find((session) => session.id === sessionId);
    if (!existing) {
      return;
    }

    set((state) => {
      const nextSessions = state.sessions.map((session) =>
        session.id === sessionId ? { ...session, agentProfileId } : session,
      );
      const next = { sessions: nextSessions };
      persistWorkspaceState({ ...state, ...next }, { immediate: true });
      return next;
    });

    get().restartSessionPanes(sessionId);
  },

  updateSessionCwd: (sessionId, cwd) => {
    const trimmed = cwd.trim();
    if (!trimmed) {
      return;
    }

    set((state) => {
      // Moving the session moves every terminal in it: a pane that had picked
      // its own folder follows too, otherwise "change folder" would silently
      // leave some panes behind.
      const nextSessions = state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              cwd: trimmed,
              layout: mapPaneNodes(session.layout, ({ cwd: _own, ...pane }) => pane),
            }
          : session,
      );
      const next = { sessions: nextSessions };
      persistWorkspaceState({ ...state, ...next }, { immediate: true });
      return next;
    });

    get().restartSessionPanes(sessionId);
  },

  updatePaneCwd: (paneId, cwd) => {
    const trimmed = cwd.trim();
    if (!trimmed) {
      return;
    }

    let changed = false;
    set((state) => {
      const nextSessions = state.sessions.map((session) => {
        if (!sessionHasPane(session, paneId)) {
          return session;
        }
        if (resolvePaneCwd(session, paneId) === trimmed) {
          return session;
        }
        changed = true;
        // Back on the session default when that is what was picked, so the
        // pane keeps following the session instead of pinning a copy of it.
        const own = trimmed === session.cwd ? undefined : trimmed;
        return { ...session, layout: setPaneCwdInLayout(session.layout, paneId, own) };
      });
      if (!changed) {
        return state;
      }
      const next = { sessions: nextSessions };
      persistWorkspaceState({ ...state, ...next }, { immediate: true });
      return next;
    });

    if (changed) {
      // A conversation belongs to a folder: the agent restarts fresh there.
      get().restartPane(paneId);
    }
  },

  setRunEverything: (enabled) => {
    saveRunEverything(enabled);
    set({ runEverything: enabled });
  },

  removeSession: (sessionId) =>
    set((state) => {
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session) {
        return state;
      }

      const paneIds = collectPaneIds(session.layout);
      const remaining = state.sessions.filter((item) => item.id !== sessionId);
      const cleanup = cleanupPaneState(state, paneIds);

      let activeSessionId = state.activeSessionId;
      let activePaneId = state.activePaneId;

      if (activeSessionId === sessionId) {
        const nextSession = remaining[0] ?? null;
        activeSessionId = nextSession?.id ?? null;
        activePaneId = nextSession
          ? (collectPaneIds(nextSession.layout)[0] ?? null)
          : null;
      }

      const spawnedSessionIds = { ...state.spawnedSessionIds };
      delete spawnedSessionIds[sessionId];

      const sessionGitContext = { ...state.sessionGitContext };
      delete sessionGitContext[sessionId];

      const next = {
        sessions: remaining,
        activeSessionId,
        activePaneId,
        spawnedSessionIds,
        sessionGitContext,
        ...cleanup,
      };
      persistWorkspaceState({ ...state, ...next }, { immediate: true });
      return next;
    }),

  reorderSessions: (fromIndex, toIndex) =>
    set((state) => {
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= state.sessions.length ||
        toIndex >= state.sessions.length ||
        fromIndex === toIndex
      ) {
        return state;
      }

      const sessions = [...state.sessions];
      const [moved] = sessions.splice(fromIndex, 1);
      sessions.splice(toIndex, 0, moved);

      const next = { sessions };
      persistWorkspaceState({ ...state, ...next });
      return next;
    }),

  togglePinSession: (sessionId) =>
    set((state) => {
      const nextSessions = state.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, pinned: !session.pinned }
          : session,
      );
      const next = { sessions: nextSessions };
      persistWorkspaceState({ ...state, ...next });
      return next;
    }),

  restartPane: (paneId, options) =>
    set((state) => {
      const hasPane = state.sessions.some((session) =>
        sessionHasPane(session, paneId),
      );

      if (!hasPane) {
        return state;
      }

      const restoredPaneIds = { ...state.restoredPaneIds };
      const paneResumeSessionIds = { ...state.paneResumeSessionIds };
      const paneResumeAnchors = { ...state.paneResumeAnchors };
      const pendingConversationLabels = { ...state.pendingConversationLabels };
      // Explicit false: fresh agent (e.g. after /exit). Explicit true: keep
      // --continue. Undefined: leave hydrate flag alone (supervisor/cwd).
      if (options?.continueConversation === true) {
        restoredPaneIds[paneId] = true;
      } else if (options?.continueConversation === false) {
        delete restoredPaneIds[paneId];
        // The old anchor no longer reflects what this pane is doing — a
        // fresh spawn re-anchors itself once pane-resume-anchor.ts detects
        // the new transcript, but until then a restart shouldn't leave a
        // stale --resume id sitting around for the next app launch.
        delete paneResumeAnchors[paneId];
        // The parked name belonged to the conversation being dropped.
        delete pendingConversationLabels[paneId];
      }
      // A plain restart (either direction) always leaves any explicitly
      // picked --resume id behind — only `resumePane` should set it.
      if (options?.continueConversation !== undefined) {
        delete paneResumeSessionIds[paneId];
      }

      const next = {
        paneRestartKeys: {
          ...state.paneRestartKeys,
          [paneId]: (state.paneRestartKeys[paneId] ?? 0) + 1,
        },
        paneRuntime: resetPaneRuntime(state.paneRuntime, paneId),
        restoredPaneIds,
        paneResumeSessionIds,
        paneResumeAnchors,
        pendingConversationLabels,
      };
      persistWorkspaceState({ ...state, ...next });
      return next;
    }),

  resumePane: (paneId, sessionId) =>
    set((state) => {
      const hasPane = state.sessions.some((session) =>
        sessionHasPane(session, paneId),
      );

      if (!hasPane) {
        return state;
      }

      // A manual pick from the dropdown also anchors the pane, so the next
      // app restart resumes this exact conversation instead of falling
      // back to a blanket --continue.
      const paneResumeAnchors = { ...state.paneResumeAnchors, [paneId]: sessionId };
      // The pane is jumping to a conversation that already exists, so a name
      // typed for the previous one must not follow it over.
      const pendingConversationLabels = { ...state.pendingConversationLabels };
      delete pendingConversationLabels[paneId];

      const next = {
        paneRestartKeys: {
          ...state.paneRestartKeys,
          [paneId]: (state.paneRestartKeys[paneId] ?? 0) + 1,
        },
        paneRuntime: resetPaneRuntime(state.paneRuntime, paneId),
        restoredPaneIds: { ...state.restoredPaneIds, [paneId]: true },
        paneResumeSessionIds: { ...state.paneResumeSessionIds, [paneId]: sessionId },
        paneResumeAnchors,
        pendingConversationLabels,
      };
      persistWorkspaceState({ ...state, ...next });
      return next;
    }),

  notePaneResumeAnchor: (paneId, sessionId) =>
    set((state) => {
      const hasPane = state.sessions.some((session) =>
        sessionHasPane(session, paneId),
      );
      if (!hasPane || state.paneResumeAnchors[paneId] === sessionId) {
        return state;
      }

      const parked = state.pendingConversationLabels[paneId];
      const pendingConversationLabels = { ...state.pendingConversationLabels };
      delete pendingConversationLabels[paneId];

      const next = {
        paneResumeAnchors: { ...state.paneResumeAnchors, [paneId]: sessionId },
        conversationLabels: parked
          ? pruneConversationLabels({
              ...state.conversationLabels,
              [sessionId]: parked,
            })
          : state.conversationLabels,
        pendingConversationLabels,
      };
      persistWorkspaceState({ ...state, ...next });
      return next;
    }),

  clearPaneResumeAnchor: (paneId) =>
    set((state) => {
      if (state.paneResumeAnchors[paneId] === undefined) {
        return state;
      }

      const paneResumeAnchors = { ...state.paneResumeAnchors };
      delete paneResumeAnchors[paneId];

      const next = { paneResumeAnchors };
      persistWorkspaceState({ ...state, ...next }, { immediate: true });
      return next;
    }),

  setConversationLabel: (cliSessionId, label) =>
    set((state) => {
      const normalized = normalizeConversationLabel(label);
      if ((state.conversationLabels[cliSessionId] ?? "") === normalized) {
        return state;
      }

      const conversationLabels = { ...state.conversationLabels };
      if (normalized) {
        conversationLabels[cliSessionId] = normalized;
      } else {
        delete conversationLabels[cliSessionId];
      }

      const next = {
        conversationLabels: pruneConversationLabels(conversationLabels),
      };
      persistWorkspaceState({ ...state, ...next });
      return next;
    }),

  setPaneConversationLabel: (paneId, label) => {
    const anchor = get().paneResumeAnchors[paneId];
    if (anchor) {
      get().setConversationLabel(anchor, label);
      return;
    }

    set((state) => {
      const normalized = normalizeConversationLabel(label);
      if ((state.pendingConversationLabels[paneId] ?? "") === normalized) {
        return state;
      }

      const pendingConversationLabels = { ...state.pendingConversationLabels };
      if (normalized) {
        pendingConversationLabels[paneId] = normalized;
      } else {
        delete pendingConversationLabels[paneId];
      }

      // Parked names live only until the anchor shows up, so nothing to persist.
      return { pendingConversationLabels };
    });
  },

  noteConversationTitles: (entries) =>
    set((state) => {
      let changed = false;
      const conversationTitles = { ...state.conversationTitles };
      for (const entry of entries) {
        if (conversationTitles[entry.id] !== entry.title) {
          conversationTitles[entry.id] = entry.title;
          changed = true;
        }
      }
      return changed ? { conversationTitles } : state;
    }),

  restartTargetPanes: () =>
    set((state) => {
      const paneIds = get().getTargetPaneIds();
      if (paneIds.length === 0) {
        return state;
      }

      const paneRestartKeys = { ...state.paneRestartKeys };
      let paneRuntime = state.paneRuntime;

      for (const paneId of paneIds) {
        paneRestartKeys[paneId] = (paneRestartKeys[paneId] ?? 0) + 1;
        paneRuntime = resetPaneRuntime(paneRuntime, paneId);
      }

      return { paneRestartKeys, paneRuntime };
    }),

  splitActivePane: (direction) => {
    const { activePaneId } = get();
    if (activePaneId) {
      get().splitPane(activePaneId, direction);
    }
  },

  splitPane: (targetPaneId, direction) =>
    set((state) => {
      const session =
        state.sessions.find((item) => sessionHasPane(item, targetPaneId)) ?? null;

      if (!session) {
        return state;
      }

      const newPaneId = createPaneId();
      // A split inherits the folder of the pane it came from — its own one
      // when it picked one, otherwise it follows the session like its sibling.
      const layout = splitPaneInLayout(
        session.layout,
        targetPaneId,
        direction,
        newPaneId,
        findPaneNode(session.layout, targetPaneId)?.cwd,
      );

      const nextSessions: AgentSession[] = state.sessions.map((item) =>
        item.id === session.id ? { ...item, layout } : item,
      );
      const paneRuntime = {
        ...state.paneRuntime,
        [newPaneId]: createPaneRuntime(),
      };
      const next = { sessions: nextSessions, paneRuntime };
      persistWorkspaceState({ ...state, ...next }, { immediate: true });
      return next;
    }),

  closePane: (paneId) =>
    set((state) => {
      const session = state.sessions.find((item) =>
        sessionHasPane(item, paneId),
      );
      if (!session) {
        return state;
      }

      const paneIds = collectPaneIds(session.layout);
      if (paneIds.length <= 1) {
        return state;
      }

      const layout = closePaneInLayout(session.layout, paneId);
      const cleanup = cleanupPaneState(state, [paneId]);

      const nextSessions = state.sessions.map((item) =>
        item.id === session.id ? { ...item, layout } : item,
      );

      const activePaneId =
        state.activePaneId === paneId
          ? collectPaneIds(layout)[0] ?? null
          : state.activePaneId;

      const next = { sessions: nextSessions, activePaneId, ...cleanup };
      persistWorkspaceState({ ...state, ...next }, { immediate: true });
      return next;
    }),

  restartSessionPanes: (sessionId) => {
    const session = get().sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }

    const paneIds = collectPaneIds(session.layout);
    if (paneIds.length === 0) {
      return;
    }

    set((state) => {
      const paneRestartKeys = { ...state.paneRestartKeys };
      let paneRuntime = state.paneRuntime;

      for (const paneId of paneIds) {
        paneRestartKeys[paneId] = (paneRestartKeys[paneId] ?? 0) + 1;
        paneRuntime = resetPaneRuntime(paneRuntime, paneId);
      }

      return { paneRestartKeys, paneRuntime };
    });
  },

  updateSplitRatio: (sessionId, path, ratio, options) =>
    set((state) => {
      const nextSessions = state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              layout: updateSplitRatioInLayout(session.layout, path, ratio),
            }
          : session,
      );
      const next = { sessions: nextSessions };

      if (options?.persist !== false) {
        persistWorkspaceState({ ...state, ...next });
      }

      return next;
    }),

  updatePaneStatus: (paneId, status) =>
    set((state) => {
      const current = state.paneRuntime[paneId] ?? createPaneRuntime();
      if (current.status === status) {
        return state;
      }

      return {
        paneRuntime: {
          ...state.paneRuntime,
          [paneId]: { ...current, status },
        },
      };
    }),

  updatePaneActivity: (paneId, activity) =>
    set((state) => {
      const current = state.paneRuntime[paneId] ?? createPaneRuntime();
      if (current.activity === activity) {
        return state;
      }

      return {
        paneRuntime: {
          ...state.paneRuntime,
          [paneId]: { ...current, activity, activitySince: Date.now() },
        },
      };
    }),

  updatePaneContext: (paneId, contextPercent) =>
    set((state) => {
      const current = state.paneRuntime[paneId] ?? createPaneRuntime();
      if (current.contextPercent === contextPercent) {
        return state;
      }

      return {
        paneRuntime: {
          ...state.paneRuntime,
          [paneId]: { ...current, contextPercent },
        },
      };
    }),

  registerPtyWriter: (paneId, write) =>
    set((state) => ({
      ptyWriters: {
        ...state.ptyWriters,
        [paneId]: write,
      },
    })),

  unregisterPtyWriter: (paneId) =>
    set((state) => {
      const next = { ...state.ptyWriters };
      delete next[paneId];
      return { ptyWriters: next };
    }),

  setVoiceRecordingPaneId: (paneId) => set({ voiceRecordingPaneId: paneId }),

  setVoiceTranscribingPaneId: (paneId) =>
    set({ voiceTranscribingPaneId: paneId }),

  setSessionGitContext: (sessionId, context) =>
    set((state) => ({
      sessionGitContext: {
        ...state.sessionGitContext,
        [sessionId]: context,
      },
    })),

  mergeSessionGitContext: (sessionId, partial) =>
    set((state) => {
      const current = state.sessionGitContext[sessionId];
      const nextContext: GitContext = {
        repoRoot: partial.repoRoot ?? current?.repoRoot ?? null,
        branch: partial.branch ?? current?.branch ?? null,
        headShort: partial.headShort ?? current?.headShort ?? null,
        headRef: partial.headRef ?? current?.headRef ?? "",
        isDirty: partial.isDirty ?? current?.isDirty ?? false,
        lastTouchedPath:
          partial.lastTouchedPath ?? current?.lastTouchedPath ?? null,
        lastTouchedAt:
          partial.lastTouchedAt ?? current?.lastTouchedAt ?? null,
        source: partial.source ?? current?.source ?? "initial",
      };

      if (current && gitContextsEqual(current, nextContext)) {
        return state;
      }

      return {
        sessionGitContext: {
          ...state.sessionGitContext,
          [sessionId]: nextContext,
        },
      };
    }),

  setPaneGitContext: (paneId, context) =>
    set((state) => ({
      paneGitContext: {
        ...state.paneGitContext,
        [paneId]: context,
      },
    })),

  mergePaneGitContext: (paneId, partial) =>
    set((state) => {
      const current = state.paneGitContext[paneId];
      const nextContext: GitContext = {
        repoRoot: partial.repoRoot ?? current?.repoRoot ?? null,
        branch: partial.branch ?? current?.branch ?? null,
        headShort: partial.headShort ?? current?.headShort ?? null,
        headRef: partial.headRef ?? current?.headRef ?? "",
        isDirty: partial.isDirty ?? current?.isDirty ?? false,
        lastTouchedPath:
          partial.lastTouchedPath ?? current?.lastTouchedPath ?? null,
        lastTouchedAt:
          partial.lastTouchedAt ?? current?.lastTouchedAt ?? null,
        source: partial.source ?? current?.source ?? "initial",
      };

      if (current && gitContextsEqual(current, nextContext)) {
        return state;
      }

      return {
        paneGitContext: {
          ...state.paneGitContext,
          [paneId]: nextContext,
        },
      };
    }),

  getActiveSession: () => {
    const { sessions, activeSessionId } = get();
    return sessions.find((session) => session.id === activeSessionId) ?? null;
  },

  getTargetPaneIds: () => {
    const { activePaneId, runEverything } = get();
    const session = get().getActiveSession();

    if (!session) {
      return [];
    }

    const paneIds = collectPaneIds(session.layout);

    if (runEverything) {
      return paneIds;
    }

    if (activePaneId && paneIds.includes(activePaneId)) {
      return [activePaneId];
    }

    return paneIds.slice(0, 1);
  },
}));

export function createEmptySession(
  session: Omit<AgentSession, "layout"> & {
    layout?: AgentSession["layout"];
  },
): AgentSession {
  const paneId = createPaneId();

  return {
    ...session,
    layout: session.layout ?? createInitialLayout(paneId),
  };
}
