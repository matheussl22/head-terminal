import { debounce } from "./debounce";
import type { AgentSession, LayoutNode, SessionStatus } from "../types/session";
import { collectPaneIds } from "./session-layout";

function resolveStorageKey(): string {
  if (import.meta.env.DEV) {
    return "head-terminal.workspace.v1.dev";
  }

  return "head-terminal.workspace.v1";
}

const STORAGE_KEY = resolveStorageKey();

export interface PersistedSession {
  id: string;
  title: string;
  cwd: string;
  agentProfileId: string;
  layout: LayoutNode;
  pinned?: boolean;
}

export interface PersistedWorkspace {
  version: 1;
  activeSessionId: string | null;
  activePaneId: string | null;
  sessions: PersistedSession[];
}

function createPaneStatuses(layout: LayoutNode): Record<string, SessionStatus> {
  return Object.fromEntries(
    collectPaneIds(layout).map((paneId) => [paneId, "starting"]),
  );
}

function toPersistedSession(session: AgentSession): PersistedSession {
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    agentProfileId: session.agentProfileId,
    layout: session.layout,
    pinned: session.pinned,
  };
}

export function workspaceFromStore(state: {
  sessions: AgentSession[];
  activeSessionId: string | null;
  activePaneId: string | null;
}): PersistedWorkspace {
  return {
    version: 1,
    activeSessionId: state.activeSessionId,
    activePaneId: state.activePaneId,
    sessions: state.sessions.map(toPersistedSession),
  };
}

export function hydrateWorkspace(workspace: PersistedWorkspace): {
  sessions: AgentSession[];
  activeSessionId: string | null;
  activePaneId: string | null;
} {
  const sessions: AgentSession[] = workspace.sessions.map((session) => ({
    ...session,
    paneStatuses: createPaneStatuses(session.layout),
  }));

  const activeSessionId = sessions.some(
    (session) => session.id === workspace.activeSessionId,
  )
    ? workspace.activeSessionId
    : (sessions[0]?.id ?? null);

  const activeSession =
    sessions.find((session) => session.id === activeSessionId) ?? null;
  const paneIds = activeSession ? collectPaneIds(activeSession.layout) : [];
  const activePaneId =
    workspace.activePaneId && paneIds.includes(workspace.activePaneId)
      ? workspace.activePaneId
      : (paneIds[0] ?? null);

  return { sessions, activeSessionId, activePaneId };
}

export function loadPersistedWorkspace(): PersistedWorkspace | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as PersistedWorkspace).version !== 1 ||
      !Array.isArray((parsed as PersistedWorkspace).sessions)
    ) {
      return null;
    }

    return parsed as PersistedWorkspace;
  } catch {
    return null;
  }
}

export function savePersistedWorkspace(workspace: PersistedWorkspace): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
}

const debouncedSave = debounce(savePersistedWorkspace, 400);

export function schedulePersistedWorkspace(workspace: PersistedWorkspace): void {
  debouncedSave(workspace);
}

export function flushPersistedWorkspace(workspace: PersistedWorkspace): void {
  debouncedSave.flush();
  savePersistedWorkspace(workspace);
}
