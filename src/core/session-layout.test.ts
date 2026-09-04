import { describe, expect, it } from "vitest";

import {
  collectPaneIds,
  createInitialLayout,
  createPaneId,
  findPaneNode,
  mapPaneNodes,
  resolvePaneCwd,
  setPaneCwdInLayout,
  splitPaneInLayout,
} from "./session-layout";

describe("session-layout", () => {
  it("collects pane ids from nested splits", () => {
    const left = createPaneId();
    const right = createPaneId();
    const layout = splitPaneInLayout(
      createInitialLayout(left),
      left,
      "vertical",
      right,
    );

    expect(collectPaneIds(layout)).toEqual([left, right]);
  });
});

describe("pane folders in the layout", () => {
  const session = {
    cwd: "C:\\Users\\m\\default",
    layout: {
      kind: "split" as const,
      direction: "horizontal" as const,
      ratio: 0.5,
      first: { kind: "pane" as const, paneId: "a" },
      second: { kind: "pane" as const, paneId: "b", cwd: "D:\\repo" },
    },
  };

  it("resolves a pane's own folder, else the session default", () => {
    expect(resolvePaneCwd(session, "a")).toBe("C:\\Users\\m\\default");
    expect(resolvePaneCwd(session, "b")).toBe("D:\\repo");
    expect(resolvePaneCwd(session, "missing")).toBe("C:\\Users\\m\\default");
  });

  it("gives the new pane of a split the folder it was told to inherit", () => {
    const layout = splitPaneInLayout(session.layout, "b", "vertical", "c", "D:\\repo");
    expect(findPaneNode(layout, "c")).toEqual({ kind: "pane", paneId: "c", cwd: "D:\\repo" });
    const plain = splitPaneInLayout(session.layout, "a", "vertical", "d");
    expect(findPaneNode(plain, "d")).toEqual({ kind: "pane", paneId: "d" });
  });

  it("sets and clears one pane's folder without touching the others", () => {
    const pinned = setPaneCwdInLayout(session.layout, "a", "E:\\other");
    expect(findPaneNode(pinned, "a")?.cwd).toBe("E:\\other");
    expect(findPaneNode(pinned, "b")?.cwd).toBe("D:\\repo");
    const cleared = setPaneCwdInLayout(pinned, "b", undefined);
    expect(findPaneNode(cleared, "b")).toEqual({ kind: "pane", paneId: "b" });
    expect(findPaneNode(cleared, "a")?.cwd).toBe("E:\\other");
  });

  it("maps every pane node and keeps the split structure", () => {
    const stripped = mapPaneNodes(session.layout, ({ cwd: _cwd, ...pane }) => pane);
    expect(stripped).toEqual({
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { kind: "pane", paneId: "a" },
      second: { kind: "pane", paneId: "b" },
    });
  });
});
