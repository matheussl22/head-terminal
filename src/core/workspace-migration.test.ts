import { describe, expect, it } from "vitest";

import type { PersistedWorkspace } from "./session-persistence";
import { migrateWorkspaceCwds } from "./workspace-migration";

function workspace(): PersistedWorkspace {
  return {
    version: 1,
    activeSessionId: "s1",
    activePaneId: "a",
    sessions: [
      {
        id: "s1",
        title: "mounted",
        cwd: "/mnt/c/Users/m/proj",
        agentProfileId: "claude",
        layout: {
          kind: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: { kind: "pane", paneId: "a" },
          second: { kind: "pane", paneId: "b", cwd: "/home/m/other" },
        },
      },
      {
        id: "s2",
        title: "distro",
        cwd: "/home/m/repo",
        agentProfileId: "shell",
        layout: { kind: "pane", paneId: "c" },
      },
      {
        id: "s3",
        title: "already native",
        cwd: "C:\\Users\\m\\native",
        agentProfileId: "shell",
        layout: { kind: "pane", paneId: "d" },
      },
    ],
  };
}

describe("migrateWorkspaceCwds", () => {
  it("rewrites WSL-era folders for native Windows panes", () => {
    const migrated = migrateWorkspaceCwds(workspace(), {
      isWindows: true,
      fallbackCwd: "C:\\Users\\m\\Documents",
    });

    expect(migrated.sessions[0].cwd).toBe("C:\\Users\\m\\proj");
    expect(migrated.sessions[0].layout).toEqual({
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { kind: "pane", paneId: "a" },
      // A distro-only folder has no Windows twin: default folder instead.
      second: { kind: "pane", paneId: "b", cwd: "C:\\Users\\m\\Documents" },
    });
    expect(migrated.sessions[1].cwd).toBe("C:\\Users\\m\\Documents");
    expect(migrated.sessions[2].cwd).toBe("C:\\Users\\m\\native");
  });

  it("is the identity off Windows and when nothing is POSIX", () => {
    const original = workspace();
    expect(migrateWorkspaceCwds(original, { isWindows: false, fallbackCwd: "/x" })).toBe(original);

    const native: PersistedWorkspace = { ...original, sessions: [original.sessions[2]] };
    expect(migrateWorkspaceCwds(native, { isWindows: true, fallbackCwd: "C:\\x" })).toBe(native);
  });
});
