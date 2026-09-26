import { describe, expect, it } from "vitest";

import { describeMinimizedPane, minimizedPaneTicks } from "./minimized-panes";

describe("describeMinimizedPane", () => {
  const minute = 60_000;

  it("shows how long a working agent has been at it", () => {
    expect(
      describeMinimizedPane({ activity: "working", activitySince: 0 }, { since: 0 }, 12 * minute),
    ).toEqual({ tone: "working", label: "Executando", time: "12m", attention: false });
  });

  it("flags a turn that ended while nobody was looking", () => {
    expect(
      describeMinimizedPane(
        { activity: "idle", activitySince: 3 * minute, doneAt: 3 * minute },
        { since: 0 },
        5 * minute,
      ),
    ).toEqual({ tone: "done", label: "Terminou", time: "há 2m", attention: true });
  });

  it("stays quiet about a pane that is simply idle", () => {
    expect(
      describeMinimizedPane({ activity: "idle", activitySince: 0 }, { since: 0 }, minute),
    ).toEqual({ tone: "idle", label: "Pronto", attention: false });
  });

  it("says what a blocked agent waits for, always loudly", () => {
    expect(
      describeMinimizedPane(
        { activity: "waiting_input", activitySince: 0, blockedReason: "approval", blockedDetail: "Bash" },
        { since: 0 },
        30_000,
      ),
    ).toEqual({ tone: "approval", label: "Pede aprovação", time: "há 30s", attention: true });
    expect(
      describeMinimizedPane(
        { activity: "waiting_input", activitySince: 0, blockedReason: "question" },
        { since: 0 },
        30_000,
      ),
    ).toMatchObject({ tone: "waiting", label: "Fez uma pergunta", attention: true });
    expect(
      describeMinimizedPane(
        { activity: "waiting_input", activitySince: 0, blockedReason: "dialog" },
        { since: 0 },
        30_000,
      ),
    ).toMatchObject({ tone: "waiting", label: "Espera confirmação", attention: true });
  });

  it("always flags errors and a crashed agent, not a voluntary exit", () => {
    expect(
      describeMinimizedPane({ activity: "error", activitySince: 0 }, { since: 0 }, 0),
    ).toMatchObject({ tone: "error", attention: true });
    expect(
      describeMinimizedPane(
        { activity: "agent_fallback", activitySince: 0, agentExitCode: 1 },
        { since: 0 },
        0,
      ),
    ).toMatchObject({ tone: "fallback", label: "Agent caiu", attention: true });
    expect(
      describeMinimizedPane(
        { activity: "agent_fallback", activitySince: 0, agentExitCode: 0 },
        { since: 0 },
        0,
      ),
    ).toMatchObject({ tone: "fallback", label: "Agent saiu", attention: false });
  });

  it("flags an exit only when it happened while minimized", () => {
    expect(
      describeMinimizedPane({ activity: "exited", activitySince: 0 }, { since: minute }, 2 * minute),
    ).toEqual({ tone: "exited", label: "Encerrado", time: undefined, attention: false });
    expect(
      describeMinimizedPane({ activity: "exited", activitySince: 90_000 }, { since: minute }, 2 * minute),
    ).toEqual({ tone: "exited", label: "Encerrado", time: "há 30s", attention: true });
  });

  it("treats a pane with no runtime yet as starting", () => {
    expect(describeMinimizedPane(undefined, { since: 0 }, 0)).toEqual({
      tone: "starting",
      label: "Iniciando",
      attention: false,
    });
  });
});

describe("minimizedPaneTicks", () => {
  it("ticks only while the card counts time", () => {
    expect(minimizedPaneTicks({ activity: "working", activitySince: 0 })).toBe(true);
    expect(minimizedPaneTicks({ activity: "waiting_input", activitySince: 0 })).toBe(true);
    expect(minimizedPaneTicks({ activity: "idle", activitySince: 0, doneAt: 0 })).toBe(true);
    expect(minimizedPaneTicks({ activity: "idle", activitySince: 0 })).toBe(false);
    expect(minimizedPaneTicks({ activity: "starting", activitySince: 0 })).toBe(false);
    expect(minimizedPaneTicks(undefined)).toBe(false);
  });
});
