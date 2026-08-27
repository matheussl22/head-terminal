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
      paneResumeSessionIds: { [paneId]: cliSessionId },
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
