import { create } from "zustand";

import type { PaneActivity } from "../types/activity";
import {
  collectPaneIds,
  createInitialLayout,
  createPaneId,
  splitPaneInLayout,
  updateSplitRatioInLayout,
} from "./session-layout";
import {
  flushPersistedWorkspace,
  schedulePersistedWorkspace,
  workspaceFromStore,
} from "./session-persistence";
import { logEvent } from "./logger";
import {
  loadRunEverything,
  saveRunEverything,
} from "./ui-preferences";
import type { GitContext } from "../types/git-context";
import type { AgentSession, SessionStatus, SplitDirection } from "../types/session";

interface SessionStore {
  sessions: AgentSession[];
  activeSessionId: string | null;
  activePaneId: string | null;
  paneRestartKeys: Record<string, number>;
  paneActivities: Record<string, PaneActivity>;
  ptyWriters: Record<string, (data: string) => void>;
  runEverything: boolean;
  spawnedSessionIds: Record<string, boolean>;
  sessionGitContext: Record<string, GitContext>;
  paneGitContext: Record<string, GitContext>;
  addSession: (session: AgentSession) => void;
  hydrateWorkspace: (
    sessions: AgentSession[],
    activeSessionId: string | null,
    activePaneId: string | null,
  ) => void;
  setActiveSessionId: (sessionId: string) => void;
  setActivePaneId: (paneId: string) => void;
  renameSession: (sessionId: string, title: string) => void;
  updateSessionAgent: (sessionId: string, agentProfileId: string) => void;
  updateSessionCwd: (sessionId: string, cwd: string) => void;
  setRunEverything: (enabled: boolean) => void;
  removeSession: (sessionId: string) => void;
  reorderSessions: (fromIndex: number, toIndex: number) => void;
  togglePinSession: (sessionId: string) => void;
  splitActivePane: (direction: SplitDirection) => void;
  updateSplitRatio: (
    sessionId: string,
    path: number[],
    ratio: number,
    options?: { persist?: boolean },
  ) => void;
  restartPane: (paneId: string) => void;
  restartTargetPanes: () => void;
  restartSessionPanes: (sessionId: string) => void;
  updatePaneStatus: (paneId: string, status: SessionStatus) => void;
  updatePaneActivity: (paneId: string, activity: PaneActivity) => void;
  registerPtyWriter: (paneId: string, write: (data: string) => void) => void;
  unregisterPtyWriter: (paneId: string) => void;
  setSessionGitContext: (sessionId: string, context: GitContext) => void;
  mergeSessionGitContext: (
    sessionId: string,
    partial: Partial<GitContext> & Pick<GitContext, "repoRoot" | "branch" | "headShort" | "headRef" | "isDirty" | "source">,
  ) => void;
  setPaneGitContext: (paneId: string, context: GitContext) => void;
  mergePaneGitContext: (
    paneId: string,
    partial: Partial<GitContext> & Pick<GitContext, "repoRoot" | "branch" | "headShort" | "headRef" | "isDirty" | "source">,
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

function sortSessions(sessions: AgentSession[]): AgentSession[] {
  const pinned = sessions.filter((session) => session.pinned);
  const unpinned = sessions.filter((session) => !session.pinned);
  return [...pinned, ...unpinned];
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
  });

  if (options?.immediate) {
    flushPersistedWorkspace(workspace);
    return;
  }

  schedulePersistedWorkspace(workspace);
}

function cleanupPaneState(
  state: SessionStore,
  paneIds: string[],
): Pick<
  SessionStore,
  "paneActivities" | "ptyWriters" | "paneRestartKeys" | "paneGitContext"
> {
  const paneActivities = { ...state.paneActivities };
  const ptyWriters = { ...state.ptyWriters };
  const paneRestartKeys = { ...state.paneRestartKeys };
  const paneGitContext = { ...state.paneGitContext };

  for (const paneId of paneIds) {
    delete paneActivities[paneId];
    delete ptyWriters[paneId];
    delete paneRestartKeys[paneId];
    delete paneGitContext[paneId];
  }

  return { paneActivities, ptyWriters, paneRestartKeys, paneGitContext };
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  activePaneId: null,
  paneRestartKeys: {},
  paneActivities: {},
  ptyWriters: {},
  runEverything: loadRunEverything(),
  spawnedSessionIds: {},
  sessionGitContext: {},
  paneGitContext: {},

  addSession: (session) =>
    set((state) => {
      const paneIds = collectPaneIds(session.layout);
      const paneActivities = { ...state.paneActivities };
      for (const paneId of paneIds) {
        paneActivities[paneId] = "starting";
      }

      const next = {
        sessions: sortSessions([...state.sessions, session]),
        activeSessionId: session.id,
        activePaneId: paneIds[0] ?? null,
        paneActivities,
        spawnedSessionIds: {
          ...state.spawnedSessionIds,
          [session.id]: true,
        },
      };
      persistWorkspaceState({ ...state, ...next }, { immediate: true });
      checkpointSessionSpawn(session.id);
      return next;
    }),

  hydrateWorkspace: (sessions, activeSessionId, activePaneId) => {
    const paneActivities: Record<string, PaneActivity> = {};
    for (const session of sessions) {
      for (const paneId of collectPaneIds(session.layout)) {
        paneActivities[paneId] = "starting";
      }
    }

    const spawnedSessionIds: Record<string, boolean> = {};
    if (activeSessionId) {
      spawnedSessionIds[activeSessionId] = true;
    }

    set({
      sessions: sortSessions(sessions),
      activeSessionId,
      activePaneId,
      paneRestartKeys: {},
      paneActivities,
      ptyWriters: {},
      spawnedSessionIds,
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
      const nextSessions = state.sessions.map((session) =>
        session.id === sessionId ? { ...session, cwd: trimmed } : session,
      );
      const next = { sessions: nextSessions };
      persistWorkspaceState({ ...state, ...next }, { immediate: true });
      return next;
    });

    get().restartSessionPanes(sessionId);
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
      const nextSessions = sortSessions(
        state.sessions.map((session) =>
          session.id === sessionId
            ? { ...session, pinned: !session.pinned }
            : session,
        ),
      );
      const next = { sessions: nextSessions };
      persistWorkspaceState({ ...state, ...next });
      return next;
    }),

  restartPane: (paneId) =>
    set((state) => {
      const hasPane = state.sessions.some(
        (session) => paneId in session.paneStatuses,
      );

      if (!hasPane) {
        return state;
      }

      const paneRestartKeys = {
        ...state.paneRestartKeys,
        [paneId]: (state.paneRestartKeys[paneId] ?? 0) + 1,
      };

      const paneActivities = {
        ...state.paneActivities,
        [paneId]: "starting" as PaneActivity,
      };

      const sessions = state.sessions.map((session) => {
        if (!(paneId in session.paneStatuses)) {
          return session;
        }

        return {
          ...session,
          paneStatuses: {
            ...session.paneStatuses,
            [paneId]: "starting" as SessionStatus,
          },
        };
      });

      return { paneRestartKeys, paneActivities, sessions };
    }),

  restartTargetPanes: () =>
    set((state) => {
      const paneIds = get().getTargetPaneIds();
      if (paneIds.length === 0) {
        return state;
      }

      const paneIdSet = new Set(paneIds);
      const paneRestartKeys = { ...state.paneRestartKeys };
      const paneActivities = { ...state.paneActivities };

      for (const paneId of paneIds) {
        paneRestartKeys[paneId] = (paneRestartKeys[paneId] ?? 0) + 1;
        paneActivities[paneId] = "starting";
      }

      const sessions = state.sessions.map((session) => {
        const hasMatch = Object.keys(session.paneStatuses).some((paneId) =>
          paneIdSet.has(paneId),
        );

        if (!hasMatch) {
          return session;
        }

        const paneStatuses: Record<string, SessionStatus> = {
          ...session.paneStatuses,
        };
        for (const paneId of paneIds) {
          if (paneId in paneStatuses) {
            paneStatuses[paneId] = "starting";
          }
        }

        return { ...session, paneStatuses };
      });

      return { paneRestartKeys, paneActivities, sessions };
    }),

  splitActivePane: (direction) =>
    set((state) => {
      const session =
        state.sessions.find((item) => item.id === state.activeSessionId) ?? null;
      const targetPaneId = state.activePaneId;

      if (!session || !targetPaneId) {
        return state;
      }

      const newPaneId = createPaneId();
      const layout = splitPaneInLayout(
        session.layout,
        targetPaneId,
        direction,
        newPaneId,
      );

      const nextSessions: AgentSession[] = state.sessions.map((item) =>
        item.id === session.id
          ? {
              ...item,
              layout,
              paneStatuses: {
                ...item.paneStatuses,
                [newPaneId]: "starting" as SessionStatus,
              },
            }
          : item,
      );
      const paneActivities = {
        ...state.paneActivities,
        [newPaneId]: "starting" as PaneActivity,
      };
      const next = { sessions: nextSessions, paneActivities };
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
      const paneActivities = { ...state.paneActivities };

      for (const paneId of paneIds) {
        paneRestartKeys[paneId] = (paneRestartKeys[paneId] ?? 0) + 1;
        paneActivities[paneId] = "starting";
      }

      const sessions = state.sessions.map((item) => {
        if (item.id !== sessionId) {
          return item;
        }

        const paneStatuses: Record<string, SessionStatus> = {
          ...item.paneStatuses,
        };
        for (const paneId of paneIds) {
          if (paneId in paneStatuses) {
            paneStatuses[paneId] = "starting";
          }
        }

        return { ...item, paneStatuses };
      });

      return { paneRestartKeys, paneActivities, sessions };
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
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (!(paneId in session.paneStatuses)) {
          return session;
        }

        return {
          ...session,
          paneStatuses: {
            ...session.paneStatuses,
            [paneId]: status,
          },
        };
      }),
    })),

  updatePaneActivity: (paneId, activity) =>
    set((state) => {
      if (state.paneActivities[paneId] === activity) {
        return state;
      }

      return {
        paneActivities: {
          ...state.paneActivities,
          [paneId]: activity,
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
        source: partial.source,
      };

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
        source: partial.source,
      };

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
  session: Omit<AgentSession, "layout" | "paneStatuses"> & {
    layout?: AgentSession["layout"];
    paneStatuses?: AgentSession["paneStatuses"];
  },
): AgentSession {
  const paneId = createPaneId();

  return {
    ...session,
    layout: session.layout ?? createInitialLayout(paneId),
    paneStatuses: session.paneStatuses ?? { [paneId]: "starting" },
  };
}
