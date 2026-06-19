import { create } from "zustand";

import {
  collectPaneIds,
  createInitialLayout,
  createPaneId,
  splitPaneInLayout,
  updateSplitRatioInLayout,
} from "./session-layout";
import {
  savePersistedWorkspace,
  workspaceFromStore,
} from "./session-persistence";
import type { AgentSession, SessionStatus, SplitDirection } from "../types/session";

interface SessionStore {
  sessions: AgentSession[];
  activeSessionId: string | null;
  activePaneId: string | null;
  paneRestartKeys: Record<string, number>;
  ptyWriters: Record<string, (data: string) => void>;
  addSession: (session: AgentSession) => void;
  hydrateWorkspace: (sessions: AgentSession[], activeSessionId: string | null, activePaneId: string | null) => void;
  setActiveSessionId: (sessionId: string) => void;
  setActivePaneId: (paneId: string) => void;
  renameSession: (sessionId: string, title: string) => void;
  splitActivePane: (direction: SplitDirection) => void;
  updateSplitRatio: (sessionId: string, path: number[], ratio: number) => void;
  restartPane: (paneId: string) => void;
  restartTargetPanes: () => void;
  updatePaneStatus: (paneId: string, status: SessionStatus) => void;
  registerPtyWriter: (paneId: string, write: (data: string) => void) => void;
  unregisterPtyWriter: (paneId: string) => void;
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

function persistWorkspaceState(state: SessionStore): void {
  savePersistedWorkspace(
    workspaceFromStore({
      sessions: state.sessions,
      activeSessionId: state.activeSessionId,
      activePaneId: state.activePaneId,
    }),
  );
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  activePaneId: null,
  paneRestartKeys: {},
  ptyWriters: {},

  addSession: (session) =>
    set((state) => {
      const paneIds = collectPaneIds(session.layout);
      const next = {
        sessions: [...state.sessions, session],
        activeSessionId: session.id,
        activePaneId: paneIds[0] ?? null,
      };
      persistWorkspaceState({ ...state, ...next });
      return next;
    }),

  hydrateWorkspace: (sessions, activeSessionId, activePaneId) => {
    set({
      sessions,
      activeSessionId,
      activePaneId,
      paneRestartKeys: {},
      ptyWriters: {},
    });
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
      };
      persistWorkspaceState({ ...state, ...next });
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

      return { paneRestartKeys, sessions };
    }),

  restartTargetPanes: () =>
    set((state) => {
      const paneIds = get().getTargetPaneIds();
      if (paneIds.length === 0) {
        return state;
      }

      const paneIdSet = new Set(paneIds);
      const paneRestartKeys = { ...state.paneRestartKeys };

      for (const paneId of paneIds) {
        paneRestartKeys[paneId] = (paneRestartKeys[paneId] ?? 0) + 1;
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

      return { paneRestartKeys, sessions };
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
      const next = { sessions: nextSessions };
      persistWorkspaceState({ ...state, ...next });
      return next;
    }),

  updateSplitRatio: (sessionId, path, ratio) =>
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
      persistWorkspaceState({ ...state, ...next });
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

  getActiveSession: () => {
    const { sessions, activeSessionId } = get();
    return sessions.find((session) => session.id === activeSessionId) ?? null;
  },

  getTargetPaneIds: () => {
    const { activePaneId } = get();
    const session = get().getActiveSession();

    if (!session) {
      return [];
    }

    const paneIds = collectPaneIds(session.layout);

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
