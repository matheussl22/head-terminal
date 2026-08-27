import { describe, expect, it } from "vitest";

import { EMPTY_GIT_CONTEXT } from "../types/git-context";
import { gitContextsEqual, pickGitContextForSession } from "./git-context-utils";

describe("pickGitContextForSession", () => {
  const sessionId = "session-1";
  const paneIds = ["pane-a", "pane-b"];

  it("prefers the active pane context when the session is active", () => {
    const context = pickGitContextForSession(
      sessionId,
      paneIds,
      {
        "pane-a": {
          ...EMPTY_GIT_CONTEXT,
          repoRoot: "/repo/a",
          branch: "main",
        },
        "pane-b": {
          ...EMPTY_GIT_CONTEXT,
          repoRoot: "/repo/b",
          branch: "feature/auth",
          lastTouchedAt: 100,
        },
      },
      {
        [sessionId]: {
          ...EMPTY_GIT_CONTEXT,
          repoRoot: "/repo/session",
          branch: "develop",
        },
      },
      { activePaneId: "pane-a", isActiveSession: true },
    );

    expect(context?.branch).toBe("main");
  });

  it("falls back to the most recently touched pane", () => {
    const context = pickGitContextForSession(
      sessionId,
      paneIds,
      {
        "pane-a": {
          ...EMPTY_GIT_CONTEXT,
          repoRoot: "/repo/a",
          branch: "main",
          lastTouchedAt: 50,
        },
        "pane-b": {
          ...EMPTY_GIT_CONTEXT,
          repoRoot: "/repo/b",
          branch: "feature/auth",
          lastTouchedAt: 200,
        },
      },
      {},
      { isActiveSession: false },
    );

    expect(context?.branch).toBe("feature/auth");
  });
});

describe("gitContextsEqual", () => {
  const identity = {
    ...EMPTY_GIT_CONTEXT,
    repoRoot: "/repo",
    branch: "main",
    headShort: "abc1234",
    headRef: "refs/heads/main",
    isDirty: false,
    lastTouchedPath: "src/a.ts",
  };

  it("treats lastTouchedAt and source as irrelevant to identity", () => {
    expect(
      gitContextsEqual(identity, {
        ...identity,
        lastTouchedAt: 99,
        source: "poll",
      }),
    ).toBe(true);
  });

  it("treats a lastTouchedPath change as a real update", () => {
    expect(
      gitContextsEqual(identity, {
        ...identity,
        lastTouchedPath: "src/b.ts",
      }),
    ).toBe(false);
  });
});
