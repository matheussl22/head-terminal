import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentHookEventPayload, ClaudeHookSettings } from "../../electron/types/api";
import {
  getClaudeHookSettingsPath,
  resetAgentHooksBridgeForTests,
  subscribeAgentHookEvents,
} from "./agent-hooks-bridge";

const PANE_A = "0d4c9a51-7f39-4a8e-9b0e-2d6f1c3e5a77";
const PANE_B = "5b7e0f2c-1d3a-4c8b-9e6f-7a2d4b1c0e99";

let emit: ((event: AgentHookEventPayload) => void) | null;
let unsubscribeIpc: ReturnType<typeof vi.fn>;
let getClaudeSettings: ReturnType<
  typeof vi.fn<(paneId: string) => Promise<ClaudeHookSettings | null>>
>;
let onEvent: ReturnType<typeof vi.fn>;

function hookEvent(paneId: string, event = "Stop"): AgentHookEventPayload {
  return { paneId, source: "claude", event, receivedAt: 1 };
}

beforeEach(() => {
  emit = null;
  unsubscribeIpc = vi.fn();
  getClaudeSettings = vi.fn(async (_paneId: string) => ({
    settingsPath: "/data/agent-hooks/panes/pane.json",
  }));
  onEvent = vi.fn((callback: (event: AgentHookEventPayload) => void) => {
    emit = callback;
    return unsubscribeIpc;
  });
  vi.stubGlobal("window", { headTerminal: { agentHooks: { getClaudeSettings, onEvent } } });
});

afterEach(() => {
  resetAgentHooksBridgeForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("agent hook events", () => {
  it("routes each event to the listeners of its own pane over one subscription", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeAgentHookEvents(PANE_A, a);
    subscribeAgentHookEvents(PANE_B, b);
    expect(onEvent).toHaveBeenCalledOnce();

    emit?.(hookEvent(PANE_A, "PermissionRequest"));
    emit?.(hookEvent("not-a-live-pane"));
    expect(a).toHaveBeenCalledWith(hookEvent(PANE_A, "PermissionRequest"));
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it("stops delivering to a listener once it unsubscribes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeAgentHookEvents(PANE_A, first);
    subscribeAgentHookEvents(PANE_A, second);

    unsubscribeFirst();
    emit?.(hookEvent(PANE_A));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("keeps delivering when one listener throws", () => {
    const after = vi.fn();
    subscribeAgentHookEvents(PANE_A, () => {
      throw new Error("boom");
    });
    subscribeAgentHookEvents(PANE_A, after);
    expect(() => emit?.(hookEvent(PANE_A))).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
  });

  it("works without the preload API (tests, a stale renderer) and drops the IPC on reset", () => {
    vi.stubGlobal("window", {});
    const unsubscribe = subscribeAgentHookEvents(PANE_A, vi.fn());
    expect(onEvent).not.toHaveBeenCalled();
    unsubscribe();

    vi.stubGlobal("window", { headTerminal: { agentHooks: { getClaudeSettings, onEvent } } });
    subscribeAgentHookEvents(PANE_A, vi.fn());
    expect(onEvent).toHaveBeenCalledOnce();
    resetAgentHooksBridgeForTests();
    expect(unsubscribeIpc).toHaveBeenCalledOnce();
  });
});

describe("Claude hook settings", () => {
  it("asks the main process on every spawn, for that pane's own file", async () => {
    getClaudeSettings.mockImplementation(async (paneId: string) => ({
      settingsPath: `/data/agent-hooks/panes/${paneId}.json`,
    }));
    await expect(getClaudeHookSettingsPath(PANE_A)).resolves.toBe(
      `/data/agent-hooks/panes/${PANE_A}.json`,
    );
    await expect(getClaudeHookSettingsPath(PANE_B)).resolves.toBe(
      `/data/agent-hooks/panes/${PANE_B}.json`,
    );
    // No cache: a restart asks again, which is when the main process puts
    // back a file that was deleted under the app.
    await getClaudeHookSettingsPath(PANE_A);
    expect(getClaudeSettings.mock.calls).toEqual([[PANE_A], [PANE_B], [PANE_A]]);
  });

  it("treats a null answer, a failed request or a missing API as no hooks", async () => {
    getClaudeSettings.mockResolvedValueOnce(null);
    await expect(getClaudeHookSettingsPath(PANE_A)).resolves.toBeUndefined();
    getClaudeSettings.mockResolvedValueOnce({ settingsPath: "" });
    await expect(getClaudeHookSettingsPath(PANE_A)).resolves.toBeUndefined();
    getClaudeSettings.mockRejectedValueOnce(new Error("no handler"));
    await expect(getClaudeHookSettingsPath(PANE_A)).resolves.toBeUndefined();
    // The next spawn is not stuck with the earlier answer.
    await expect(getClaudeHookSettingsPath(PANE_A)).resolves.toBe(
      "/data/agent-hooks/panes/pane.json",
    );

    vi.stubGlobal("window", {});
    await expect(getClaudeHookSettingsPath(PANE_A)).resolves.toBeUndefined();
  });
});
