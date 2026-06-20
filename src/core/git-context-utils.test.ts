import { describe, expect, it } from "vitest";

import { EMPTY_GIT_CONTEXT } from "../types/git-context";
import { pickGitContextForSession } from "./git-context-utils";

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
