import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PaneSupervisor, type SupervisorPaneState } from "./pane-supervisor";

describe("PaneSupervisor", () => {
  let restart: ReturnType<typeof vi.fn<(paneId: string) => void>>;
  let states: Array<SupervisorPaneState | null>;
  let supervisor: PaneSupervisor;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    restart = vi.fn<(paneId: string) => void>();
    states = [];
    supervisor = new PaneSupervisor({
      restart,
      onStateChange: (_paneId, state) => states.push(state),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not auto-restart on exit — waits for manual restart", () => {
    supervisor.noteSpawned("p1");

    supervisor.noteExit("p1");
    expect(supervisor.getState("p1")).toMatchObject({ kind: "failed" });
    vi.advanceTimersByTime(60_000);
    expect(restart).not.toHaveBeenCalled();

    supervisor.restartNow("p1");
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("scheduleRestart uses exponential backoff", () => {
    supervisor.noteSpawned("p1");

    supervisor.scheduleRestart("p1");
    expect(supervisor.getState("p1")).toMatchObject({
      kind: "countdown",
      attempt: 1,
    });
    vi.advanceTimersByTime(500);
    expect(restart).toHaveBeenCalledTimes(1);

    supervisor.noteSpawned("p1");
    supervisor.scheduleRestart("p1");
    vi.advanceTimersByTime(999);
    expect(restart).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("scheduleRestart fails after max attempts", () => {
    supervisor.noteSpawned("p1");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      supervisor.scheduleRestart("p1");
      vi.advanceTimersByTime(10_000);
      supervisor.noteSpawned("p1");
    }

    expect(restart).toHaveBeenCalledTimes(5);
    supervisor.scheduleRestart("p1");
    expect(supervisor.getState("p1")).toMatchObject({ kind: "failed" });
    vi.advanceTimersByTime(60_000);
    expect(restart).toHaveBeenCalledTimes(5);
  });

  it("resets the attempt counter after 60s healthy", () => {
    supervisor.noteSpawned("p1");
    supervisor.scheduleRestart("p1");
    vi.advanceTimersByTime(500);
    supervisor.noteSpawned("p1");

    // Stay healthy past the reset window.
    vi.setSystemTime(Date.now() + 61_000);
    supervisor.scheduleRestart("p1");

    expect(supervisor.getState("p1")).toMatchObject({
      kind: "countdown",
      attempt: 1,
    });
  });

  it("cancel stops respawning until manual restart", () => {
    supervisor.noteSpawned("p1");
    supervisor.scheduleRestart("p1");
    supervisor.cancel("p1");

    vi.advanceTimersByTime(60_000);
    expect(restart).not.toHaveBeenCalled();
    expect(supervisor.getState("p1")).toMatchObject({ kind: "user_stopped" });

    supervisor.noteExit("p1");
    expect(supervisor.getState("p1")).toMatchObject({ kind: "user_stopped" });

    supervisor.restartNow("p1");
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("restartNow skips the countdown", () => {
    supervisor.noteSpawned("p1");
    supervisor.scheduleRestart("p1");
    supervisor.restartNow("p1");

    expect(restart).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("forget drops state and timers", () => {
    supervisor.noteSpawned("p1");
    supervisor.scheduleRestart("p1");
    supervisor.forget("p1");

    vi.advanceTimersByTime(60_000);
    expect(restart).not.toHaveBeenCalled();
    expect(supervisor.getState("p1")).toBeNull();
    expect(states[states.length - 1]).toBeNull();
  });
});
