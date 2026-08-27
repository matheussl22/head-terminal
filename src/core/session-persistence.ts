import { debounce } from "./debounce";
import { logError } from "./logger";
import type { AgentSession, LayoutNode } from "../types/session";
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
  claudeAccountId?: string;
  layout: LayoutNode;
  pinned?: boolean;
}

export interface PersistedWorkspace {
  version: 1;
  activeSessionId: string | null;
  activePaneId: string | null;
  sessions: PersistedSession[];
  /** paneId -> last known CLI session id, so a restart can `--resume` each
   * pane's own conversation instead of a blanket `--continue` that collides
   * whenever panes share a cwd. */
  paneResumeSessionIds?: Record<string, string>;
  /** CLI session id -> name the user gave that conversation, so a renamed
   * conversation stays renamed in the pane header and the resume dropdown. */
  conversationLabels?: Record<string, string>;
}

function toPersistedSession(session: AgentSession): PersistedSession {
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    agentProfileId: session.agentProfileId,
    claudeAccountId: session.claudeAccountId,
    layout: session.layout,
    pinned: session.pinned,
  };
}

export function workspaceFromStore(state: {
  sessions: AgentSession[];
  activeSessionId: string | null;
  activePaneId: string | null;
  paneResumeSessionIds?: Record<string, string>;
  conversationLabels?: Record<string, string>;
}): PersistedWorkspace {
  return {
    version: 1,
    activeSessionId: state.activeSessionId,
    activePaneId: state.activePaneId,
    sessions: state.sessions.map(toPersistedSession),
    paneResumeSessionIds: state.paneResumeSessionIds,
    conversationLabels: state.conversationLabels,
  };
}

export function hydrateWorkspace(workspace: PersistedWorkspace): {
  sessions: AgentSession[];
  activeSessionId: string | null;
  activePaneId: string | null;
  paneResumeSessionIds: Record<string, string>;
  conversationLabels: Record<string, string>;
} {
  const sessions: AgentSession[] = workspace.sessions.map((session) => ({
    ...session,
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

  // Only keep anchors for panes that actually survived hydration — stale
  // ids from a since-closed pane must not leak onto whatever new pane
  // happens to reuse... (they never do, paneId is a fresh uuid, but this
  // keeps the persisted map from growing unbounded across the app's life).
  const allPaneIds = new Set(
    sessions.flatMap((session) => collectPaneIds(session.layout)),
  );
  const paneResumeSessionIds: Record<string, string> = {};
  for (const [paneId, sessionId] of Object.entries(
    workspace.paneResumeSessionIds ?? {},
  )) {
    if (allPaneIds.has(paneId)) {
      paneResumeSessionIds[paneId] = sessionId;
    }
  }

  // Conversation names are keyed by CLI session id, which no pane owns — they
  // outlive panes on purpose, so they are restored as-is.
  const conversationLabels: Record<string, string> = {};
  for (const [cliSessionId, label] of Object.entries(
    workspace.conversationLabels ?? {},
  )) {
    if (typeof label === "string" && label) {
      conversationLabels[cliSessionId] = label;
    }
  }

  return {
    sessions,
    activeSessionId,
    activePaneId,
    paneResumeSessionIds,
    conversationLabels,
  };
}

function loadLegacyWorkspace(): PersistedWorkspace | null {
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

export async function loadPersistedWorkspace(): Promise<PersistedWorkspace | null> {
  if (typeof window !== "undefined" && window.headTerminal) {
    try {
      const stored = await window.headTerminal.workspace.load();
      if (
        stored &&
        stored.version === 1 &&
        Array.isArray(stored.sessions)
      ) {
        return stored as unknown as PersistedWorkspace;
      }
    } catch {
      // A first-run migration may still recover the legacy renderer storage.
    }
  }

  const legacy = loadLegacyWorkspace();
  if (legacy && typeof window !== "undefined" && window.headTerminal) {
    void window.headTerminal.workspace.save(legacy).catch((error: unknown) => {
      logError("workspace.legacy_migration_save_failed", error);
    });
  }
  return legacy;
}

export async function savePersistedWorkspace(
  workspace: PersistedWorkspace,
): Promise<void> {
  if (typeof window !== "undefined" && window.headTerminal) {
    await window.headTerminal.workspace.save(workspace);
    return;
  }
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
  }
}

const debouncedSave = debounce((workspace: PersistedWorkspace) => {
  void savePersistedWorkspace(workspace).catch((error: unknown) => {
    logError("workspace.save_failed", error);
  });
}, 400);

export function schedulePersistedWorkspace(workspace: PersistedWorkspace): void {
  debouncedSave(workspace);
}

export async function flushPersistedWorkspace(
  workspace: PersistedWorkspace,
): Promise<void> {
  debouncedSave.cancel();
  await savePersistedWorkspace(workspace);
}
