import { describe, expect, it } from "vitest";

import {
  describePaneStatus,
  describeSessionStatus,
  formatStatusDetail,
  formatStatusLine,
  summarizeToneCounts,
  type PaneStatusRuntime,
} from "./activity-display";

function pane(
  activity: PaneStatusRuntime["activity"],
  activitySince = 0,
  extra: Partial<PaneStatusRuntime> = {},
): PaneStatusRuntime {
  return { activity, activitySince, ...extra };
}

describe("describePaneStatus", () => {
  it("says what a blocked pane waits for", () => {
    const view = describePaneStatus(
      pane("waiting_input", 0, { blockedReason: "approval", blockedDetail: "Bash" }),
    );
    expect(view).toMatchObject({ tone: "waiting", label: "Aguardando", attention: true, since: 0 });
    expect(formatStatusDetail(view, 120_000)).toBe("Aguardando você: pede aprovação (Bash) · há 2m");
  });

  it("tells a finished turn nobody saw from a plain idle pane", () => {
    expect(describePaneStatus(pane("idle", 0, { doneAt: 5_000 }))).toMatchObject({
      tone: "done",
      label: "Concluído",
      // Neutral: the window may have been minimized, not another terminal.
      detail: "Concluído — terminou enquanto você não estava olhando",
      attention: true,
      since: 5_000,
    });
    const idle = describePaneStatus(pane("idle", 0));
    expect(idle).toMatchObject({ tone: "idle", label: "Pronto", attention: false });
    expect(idle.since).toBeUndefined();
    expect(formatStatusLine(idle)).toBe("Pronto");
  });

  it("ticks the clock of a working pane", () => {
    expect(formatStatusLine(describePaneStatus(pane("working", 0)), 90_000)).toBe("Executando há 1m");
  });

  it("does not alarm about an agent the user closed on purpose", () => {
    expect(describePaneStatus(pane("agent_fallback", 0, { agentExitCode: 0 }))).toMatchObject({
      tone: "fallback",
      attention: false,
      detail: "O agent saiu — shell ativo",
    });
    expect(describePaneStatus(pane("agent_fallback", 0, { agentExitCode: 3 }))).toMatchObject({
      tone: "fallback",
      attention: true,
      detail: "O agent caiu (código 3) — shell ativo",
    });
  });

  it("treats a pane without runtime as starting", () => {
    expect(describePaneStatus(undefined)).toMatchObject({ tone: "starting", label: "Iniciando" });
  });
});

describe("describeSessionStatus", () => {
  it("lets the pane that needs the user speak, timed by the longest wait", () => {
    const view = describeSessionStatus(["a", "b", "c"], {
      a: pane("working", 0),
      b: pane("waiting_input", 50_000, { blockedReason: "question" }),
      c: pane("waiting_input", 10_000, { blockedReason: "approval" }),
    });
    expect(view.tone).toBe("waiting");
    expect(view.since).toBe(10_000);
    expect(view.summary).toBe("2 aguardando · 1 executando");
    expect(view.paneCount).toBe(3);
  });

  it("reports a session that never spawned as dormant", () => {
    const view = describeSessionStatus(["a"], { a: pane("starting") }, { spawned: false });
    expect(view).toMatchObject({ tone: "dormant", label: "Não iniciada", attention: false });
  });

  // Review store-ui-semantics#3, harness F1: a shell left by /exit outranked
  // a sibling's finished turn, so the session read "Shell" and never
  // "Concluído".
  it("lets a shell left by the user's own /exit rank as calm as an idle pane", () => {
    const exited = pane("agent_fallback", 0, { agentExitCode: 0 });
    expect(describeSessionStatus(["a", "b"], { a: exited, b: pane("idle", 0, { doneAt: 1 }) }).tone).toBe(
      "done",
    );
    expect(describeSessionStatus(["a", "b"], { a: exited, b: pane("working", 0) }).tone).toBe("working");
    expect(
      describeSessionStatus(["a", "b"], {
        a: exited,
        b: pane("waiting_input", 0, { blockedReason: "question" }),
      }).tone,
    ).toBe("waiting");
    // Above what is really quieter.
    expect(describeSessionStatus(["a", "b"], { a: pane("exited", 0), b: exited }).tone).toBe("fallback");
  });

  it("still lets a crashed agent speak over work and finished turns", () => {
    const crashed = pane("agent_fallback", 0, { agentExitCode: 1 });
    expect(describeSessionStatus(["a", "b"], { a: pane("working", 0), b: crashed })).toMatchObject({
      tone: "fallback",
      attention: true,
    });
    expect(
      describeSessionStatus(["a", "b"], { a: pane("idle", 0, { doneAt: 1 }), b: crashed }).tone,
    ).toBe("fallback");
  });

  it("has no summary for a single pane", () => {
    expect(describeSessionStatus(["a"], { a: pane("working") }).summary).toBe("");
  });
});

describe("summarizeToneCounts", () => {
  it("only summarizes when more than one pane has something to say", () => {
    expect(summarizeToneCounts({ working: 1, idle: 3 })).toBe("");
    expect(summarizeToneCounts({ working: 2, idle: 3 })).toBe("2 executando");
    expect(summarizeToneCounts({ waiting: 1, done: 2 })).toBe("1 aguardando · 2 concluídos");
    expect(summarizeToneCounts({ idle: 4 })).toBe("");
  });
});
