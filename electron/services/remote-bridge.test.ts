import { afterEach, describe, expect, it, vi } from "vitest";

import type { RemoteCommandRequest, RemoteScreen, RemoteSnapshot } from "../../src/types/remote";
import { RemoteBridge, type RemoteRenderer } from "./remote-bridge";

function snapshot(paneIds: string[]): RemoteSnapshot {
  return {
    updatedAt: 1,
    sessions: [
      {
        sessionId: "s",
        title: "S",
        cwd: "/repo",
        agentProfileId: "claude",
        agentLabel: "Claude Code",
        active: true,
        pinned: false,
        state: "live",
        panes: paneIds.map((paneId, index) => ({
          paneId,
          index: index + 1,
          title: paneId,
          agentProfileId: "claude",
          activity: "idle",
          done: false,
          activitySince: 1,
        })),
      },
    ],
  };
}

function screen(paneId: string): RemoteScreen {
  return {
    paneId,
    cols: 80,
    rows: 24,
    lines: [[["$", 0]]],
    styles: [""],
    theme: { background: "#000", foreground: "#fff" },
    at: 1,
  };
}

function renderer(): RemoteRenderer & { commands: RemoteCommandRequest[]; watches: string[][] } {
  const commands: RemoteCommandRequest[] = [];
  const watches: string[][] = [];
  return {
    commands,
    watches,
    sendCommand: (request) => {
      commands.push(request);
      return true;
    },
    sendWatch: (paneIds) => watches.push(paneIds),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RemoteBridge", () => {
  it("keeps the last snapshot and screens, and tells listeners", () => {
    const bridge = new RemoteBridge(async () => "");
    const onSnapshot = vi.fn();
    const onScreen = vi.fn();
    bridge.onSnapshot(onSnapshot);
    bridge.onScreen(onScreen);

    bridge.publishState(snapshot(["a", "b"]));
    bridge.publishScreen(screen("a"));
    expect(bridge.getSnapshot()?.sessions[0].panes).toHaveLength(2);
    expect(bridge.getScreen("a")?.paneId).toBe("a");
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onScreen).toHaveBeenCalledTimes(1);

    // A pane that left the list takes its screen with it.
    bridge.publishState(snapshot(["b"]));
    expect(bridge.getScreen("a")).toBeNull();
  });

  it("carries a command to the window and its reply back", async () => {
    const bridge = new RemoteBridge(async () => "");
    const window = renderer();
    bridge.attachRenderer(window);
    const result = bridge.runCommand({ type: "wake-session", sessionId: "s" });
    expect(window.commands).toHaveLength(1);
    bridge.replyCommand({ requestId: window.commands[0].requestId, result: { ok: true } });
    await expect(result).resolves.toEqual({ ok: true });
  });

  it("fails a command when there is no window, or it never answers", async () => {
    vi.useFakeTimers();
    const bridge = new RemoteBridge(async () => "", () => "no window");
    await expect(bridge.runCommand({ type: "wake-session", sessionId: "s" })).resolves.toEqual({
      ok: false,
      error: "no window",
    });

    bridge.attachRenderer(renderer());
    const silent = bridge.runCommand({ type: "wake-session", sessionId: "s" });
    await vi.advanceTimersByTimeAsync(16_000);
    await expect(silent).resolves.toEqual({ ok: false, error: "no window" });
  });

  it("fails what is pending when the window goes away", async () => {
    const bridge = new RemoteBridge(async () => "", () => "gone");
    bridge.attachRenderer(renderer());
    const pending = bridge.runCommand({ type: "wake-session", sessionId: "s" });
    bridge.attachRenderer(null);
    await expect(pending).resolves.toEqual({ ok: false, error: "gone" });
  });

  it("forwards what phones watch, and repeats it to a new window", () => {
    const bridge = new RemoteBridge(async () => "");
    const first = renderer();
    bridge.attachRenderer(first);
    bridge.setWatchedPanes(["b", "a", "a"]);
    expect(first.watches.at(-1)).toEqual(["a", "b"]);
    expect(bridge.watchedPanes()).toEqual(["a", "b"]);

    const second = renderer();
    bridge.attachRenderer(second);
    expect(second.watches).toEqual([["a", "b"]]);
  });

  it("transcribes through the voice service", async () => {
    const transcribe = vi.fn(async () => "olá");
    const bridge = new RemoteBridge(transcribe);
    await expect(bridge.transcribe(new Uint8Array([1]), "audio/webm")).resolves.toBe("olá");
    expect(transcribe).toHaveBeenCalledWith(new Uint8Array([1]), "audio/webm");
  });
});
