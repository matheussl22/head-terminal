import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePaneConversationView } from "./conversation-display";
import { collectPaneIds } from "./session-layout";
import { createEmptySession, useSessionStore } from "./session-manager";
import {
  hydrateWorkspace,
  workspaceFromStore,
} from "./session-persistence";
import { anchorPaneResumeSession } from "./pane-resume-anchor";

const listResumable = vi.fn();
const workspaceSave = vi.fn().mockResolvedValue(undefined);

function headerName(): string {
  const state = useSessionStore.getState();
  const paneId = state.activePaneId;
  if (!paneId) {
    return resolvePaneConversationView({}).displayName;
  }
  const cliSessionId = state.paneResumeAnchors[paneId];
  const custom = cliSessionId
    ? state.conversationLabels[cliSessionId]
    : state.pendingConversationLabels[paneId];
  return resolvePaneConversationView({
    cliSessionId,
    title: cliSessionId ? state.conversationTitles[cliSessionId] : undefined,
    customLabel: custom,
  }).displayName;
}

describe("conversation save lifecycle", () => {
  beforeEach(() => {
    listResumable.mockReset();
    workspaceSave.mockClear();
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal("window", {
      headTerminal: {
        sessions: { listResumable },
        workspace: { save: workspaceSave, load: vi.fn() },
        diagnostics: { appendEvent: vi.fn() },
      },
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("names a new chat from the first typed message and keeps that id after a restart", async () => {
    const session = createEmptySession({
      id: "sess-1",
      title: "Claude 1",
      cwd: String.raw`C:\Users\mathe`,
      agentProfileId: "claude",
    });
    useSessionStore.getState().addSession(session);
    const paneId = collectPaneIds(session.layout)[0];

    expect(headerName()).toBe("nova conversa");
    expect(
      workspaceFromStore({
        ...useSessionStore.getState(),
        paneResumeSessionIds: useSessionStore.getState().paneResumeAnchors,
      }).paneResumeSessionIds,
    ).toEqual({});

    const fallback = {
      id: "33c584af-842d-4f34-914e-103047398416",
      title: "Sessão de 26/08/2026, 09:28:00",
      fromTranscript: false,
      updatedAt: new Date(5_000).toISOString(),
    };
    const named = {
      ...fallback,
      title: "test",
      fromTranscript: true,
      updatedAt: new Date(8_000).toISOString(),
    };
    listResumable.mockResolvedValueOnce([fallback]).mockResolvedValue([named]);

    const promise = anchorPaneResumeSession({
      paneId,
      cwd: session.cwd,
      agentProfileId: "claude",
      spawnStartMs: 4_000,
      startsNewConversation: true,
      existingSessionIds: [],
      isDisposed: () => false,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(useSessionStore.getState().paneResumeAnchors[paneId]).toBe(
      fallback.id,
    );
    expect(headerName()).toBe(fallback.title);

    await vi.advanceTimersByTimeAsync(2_500);
    await promise;

    expect(headerName()).toBe("test");

    const persisted = workspaceFromStore({
      ...useSessionStore.getState(),
      paneResumeSessionIds: useSessionStore.getState().paneResumeAnchors,
    });
    expect(persisted.paneResumeSessionIds?.[paneId]).toBe(fallback.id);

    const restored = hydrateWorkspace(persisted);
    expect(restored.paneResumeSessionIds[paneId]).toBe(fallback.id);

    useSessionStore.setState(useSessionStore.getInitialState(), true);
    useSessionStore
      .getState()
      .hydrateWorkspace(
        restored.sessions,
        restored.activeSessionId,
        restored.activePaneId,
        restored.paneResumeSessionIds,
        restored.conversationLabels,
      );

    expect(headerName()).toBe("conversa 33c584af");

    useSessionStore.getState().noteConversationTitles([named]);
    expect(headerName()).toBe("test");
  });
});
