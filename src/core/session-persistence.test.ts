import { afterEach, describe, expect, it, vi } from "vitest";

import { collectPaneIds } from "./session-layout";
import { createEmptySession } from "./session-manager";
import {
  hydrateWorkspace,
  schedulePersistedWorkspace,
  workspaceFromStore,
} from "./session-persistence";

describe("workspace conversation persistence", () => {
  it("round-trips the pane's CLI session id so a restart resumes the same chat", () => {
    const session = createEmptySession({
      id: "sess-1",
      title: "Claude 1",
      cwd: "/mnt/c/Users/mathe",
      agentProfileId: "claude",
    });
    const paneId = collectPaneIds(session.layout)[0];
    const cliSessionId = "33c584af-842d-4f34-914e-103047398416";

    const persisted = workspaceFromStore({
      sessions: [session],
      activeSessionId: session.id,
      activePaneId: paneId,
      paneResumeAnchors: { [paneId]: cliSessionId },
      conversationLabels: { [cliSessionId]: "Teste salvo" },
    });

    const restored = hydrateWorkspace(persisted);
    expect(restored.paneResumeSessionIds[paneId]).toBe(cliSessionId);
    expect(restored.conversationLabels[cliSessionId]).toBe("Teste salvo");
  });

  it("drops anchors for panes that no longer exist", () => {
    const session = createEmptySession({
      id: "sess-1",
      title: "Claude 1",
      cwd: "/tmp",
      agentProfileId: "claude",
    });
    const paneId = collectPaneIds(session.layout)[0];

    const restored = hydrateWorkspace({
      version: 1,
      activeSessionId: session.id,
      activePaneId: paneId,
      sessions: [session],
      paneResumeSessionIds: {
        [paneId]: "keep-me",
        "gone-pane": "drop-me",
      },
    });

    expect(restored.paneResumeSessionIds).toEqual({ [paneId]: "keep-me" });
  });
});

describe("workspace save failures", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("logs a scheduled save failure instead of swallowing it", async () => {
    vi.useFakeTimers();
    const save = vi.fn(() => Promise.reject(new Error("ENOSPC")));
    vi.stubGlobal("window", {
      headTerminal: {
        workspace: { save, load: vi.fn() },
        diagnostics: { appendEvent: vi.fn() },
      },
    });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    schedulePersistedWorkspace({
      version: 1,
      activeSessionId: null,
      activePaneId: null,
      sessions: [],
    });
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();
    await Promise.resolve();

    expect(save).toHaveBeenCalledOnce();
    expect(
      consoleLog.mock.calls.some((call) =>
        String(call[0]).includes("workspace.save_failed"),
      ),
    ).toBe(true);
  });
});

describe("workspaceFromStore fed the whole session store (the close-time flush)", () => {
  it("persists the detected anchors, not the pending --resume ids", () => {
    const session = createEmptySession({
      id: "sess-close",
      title: "Claude",
      cwd: "/tmp",
      agentProfileId: "claude",
    });
    const paneId = collectPaneIds(session.layout)[0];
    // Shape of useSessionStore.getState(): a pane that opened a brand new
    // conversation during the session has an anchor but no --resume id yet.
    const store = {
      sessions: [session],
      activeSessionId: session.id,
      activePaneId: paneId,
      paneResumeSessionIds: {},
      paneResumeAnchors: { [paneId]: "detected-during-session" },
      conversationLabels: {},
    };

    const persisted = workspaceFromStore(store);

    expect(persisted.paneResumeSessionIds).toEqual({
      [paneId]: "detected-during-session",
    });
    expect(hydrateWorkspace(persisted).paneResumeSessionIds[paneId]).toBe(
      "detected-during-session",
    );
  });
});

describe("workspace projects persistence", () => {
  function claude(id: string, projectId?: string) {
    return createEmptySession({
      id,
      title: id,
      cwd: "/repo",
      agentProfileId: "claude",
      ...(projectId ? { projectId } : {}),
    });
  }

  it("leaves projects out of the file until there is one", () => {
    const session = claude("a");
    const persisted = workspaceFromStore({
      sessions: [session],
      activeSessionId: "a",
      activePaneId: null,
      projects: [],
      activeProjectId: null,
    });
    expect(persisted).not.toHaveProperty("projects");
    expect(persisted).not.toHaveProperty("activeProjectId");
  });

  it("round-trips projects, each session's project and the project on screen", () => {
    const persisted = workspaceFromStore({
      sessions: [claude("a", "p1"), claude("b", "p2")],
      activeSessionId: "b",
      activePaneId: null,
      projects: [
        { id: "p1", name: "Composer", cwd: "/repo", lastSessionId: "a" },
        { id: "p2", name: "Pessoal", collapsed: true },
      ],
      activeProjectId: "p2",
    });

    const restored = hydrateWorkspace(JSON.parse(JSON.stringify(persisted)));
    expect(restored.sessions.map((session) => session.projectId)).toEqual(["p1", "p2"]);
    expect(restored.projects).toEqual([
      { id: "p1", name: "Composer", cwd: "/repo", lastSessionId: "a" },
      { id: "p2", name: "Pessoal", collapsed: true },
    ]);
    expect(restored.activeProjectId).toBe("p2");
    expect(restored.activeSessionId).toBe("b");
  });

  it("keeps an empty project on screen instead of jumping to another project's session", () => {
    const restored = hydrateWorkspace({
      version: 1,
      activeSessionId: null,
      activePaneId: null,
      sessions: [claude("a", "p1")],
      projects: [
        { id: "p1", name: "Composer" },
        { id: "p2", name: "Vazio" },
      ],
      activeProjectId: "p2",
    });
    expect(restored.activeSessionId).toBeNull();
    expect(restored.activeProjectId).toBe("p2");
  });

  it("falls back to the first project when the one on screen is gone", () => {
    const restored = hydrateWorkspace({
      version: 1,
      activeSessionId: "a",
      activePaneId: null,
      sessions: [claude("a", "p1")],
      projects: [{ id: "p1", name: "Composer" }],
      activeProjectId: "deleted",
    });
    expect(restored.activeProjectId).toBe("p1");
  });
});
