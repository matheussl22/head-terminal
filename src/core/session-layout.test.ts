import { describe, expect, it } from "vitest";

import type { LayoutNode } from "../types/session";
import {
  collectPaneIds,
  collectPaneRects,
  collectSplitDividers,
  collectVisiblePaneRects,
  collectVisibleSplitDividers,
  countPanesAlong,
  createInitialLayout,
  createPaneId,
  equalizeLayout,
  findLayoutNodeAtPath,
  findPaneNode,
  isLayoutEqualized,
  mapPaneNodes,
  resolvePaneCwd,
  setPaneCwdInLayout,
  splitPaneInLayout,
  splitRatioBounds,
  updateSplitRatioInLayout,
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

describe("layout with minimized panes", () => {
  // a | (b / c), with b over c.
  const layout: LayoutNode = {
    kind: "split",
    direction: "horizontal",
    ratio: 0.4,
    first: { kind: "pane", paneId: "a" },
    second: {
      kind: "split",
      direction: "vertical",
      ratio: 0.25,
      first: { kind: "pane", paneId: "b" },
      second: { kind: "pane", paneId: "c" },
    },
  };

  it("is the full layout when nothing is hidden", () => {
    expect(collectVisiblePaneRects(layout, new Set())).toEqual(collectPaneRects(layout));
    expect(collectVisibleSplitDividers(layout, new Set())).toEqual(
      collectSplitDividers(layout),
    );
  });

  it("gives a hidden pane's room to its sibling", () => {
    expect(collectVisiblePaneRects(layout, new Set(["b"]))).toEqual([
      { paneId: "a", top: 0, left: 0, width: 40, height: 100 },
      { paneId: "c", top: 0, left: 40, width: 60, height: 100 },
    ]);
  });

  it("gives a whole hidden side to the other one", () => {
    expect(collectVisiblePaneRects(layout, new Set(["b", "c"]))).toEqual([
      { paneId: "a", top: 0, left: 0, width: 100, height: 100 },
    ]);
    expect(collectVisiblePaneRects(layout, new Set(["a"]))).toEqual([
      { paneId: "b", top: 0, left: 0, width: 100, height: 25 },
      { paneId: "c", top: 25, left: 0, width: 100, height: 75 },
    ]);
  });

  it("has nothing to lay out when every pane is hidden", () => {
    const hidden = new Set(["a", "b", "c"]);
    expect(collectVisiblePaneRects(layout, hidden)).toEqual([]);
    expect(collectVisibleSplitDividers(layout, hidden)).toEqual([]);
  });

  it("keeps each divider's path into the real tree", () => {
    // With a hidden, only b/c is split on screen: it spans the canvas but is
    // still the second child of the root, so a drag updates that ratio.
    expect(collectVisibleSplitDividers(layout, new Set(["a"]))).toEqual([
      {
        path: [1],
        direction: "vertical",
        ratio: 0.25,
        top: 0,
        left: 0,
        width: 100,
        height: 100,
      },
    ]);
    // A split with one side gone divides nothing.
    expect(collectVisibleSplitDividers(layout, new Set(["c"]))).toEqual([
      {
        path: [],
        direction: "horizontal",
        ratio: 0.4,
        top: 0,
        left: 0,
        width: 100,
        height: 100,
      },
    ]);
  });
});

describe("equalizing a layout", () => {
  const pane = (paneId: string): LayoutNode => ({ kind: "pane", paneId });
  const split = (
    direction: "horizontal" | "vertical",
    first: LayoutNode,
    second: LayoutNode,
    ratio = 0.5,
  ): LayoutNode => ({ kind: "split", direction, ratio, first, second });
  const round = (rects: ReturnType<typeof collectPaneRects>) =>
    rects.map(({ paneId, left, top, width, height }) => ({
      paneId,
      left: Math.round(left * 100) / 100,
      top: Math.round(top * 100) / 100,
      width: Math.round(width * 100) / 100,
      height: Math.round(height * 100) / 100,
    }));

  /** What pressing "dividir ao lado" on the same pane over and over leaves:
   * every split at 0.5, so the panes end up 1/2, 1/4, 1/8… of the row. */
  function repeatedSplits(count: number): LayoutNode {
    let layout: LayoutNode = pane("p1");
    for (let index = 2; index <= count; index += 1) {
      layout = splitPaneInLayout(layout, "p1", "horizontal", `p${index}`);
    }
    return layout;
  }

  it("gives every pane of a repeatedly split row the same width", () => {
    const layout = repeatedSplits(10);
    const before = collectPaneRects(layout).map((rect) => rect.width);
    expect(Math.min(...before)).toBeLessThan(1);

    const rects = collectPaneRects(equalizeLayout(layout));
    expect(rects).toHaveLength(10);
    for (const rect of rects) {
      expect(rect.width).toBeCloseTo(10, 6);
      expect(rect.height).toBe(100);
    }
  });

  it("keeps ratios under the old 15% floor (ten columns start at 0.1)", () => {
    const layout = repeatedSplits(10);
    const equalized = equalizeLayout(layout);
    expect(equalized.kind === "split" && equalized.ratio).toBeCloseTo(0.9, 6);
    const rects = collectPaneRects(equalized);
    expect(rects[rects.length - 1].width).toBeCloseTo(10, 6);
  });

  it("evens out a 5x2 grid of uneven rows", () => {
    const row = (tag: string) =>
      split(
        "horizontal",
        pane(`${tag}1`),
        split("horizontal", pane(`${tag}2`), split("horizontal", pane(`${tag}3`), split("horizontal", pane(`${tag}4`), pane(`${tag}5`), 0.8), 0.3), 0.6),
        0.7,
      );
    const layout = split("vertical", row("a"), row("b"), 0.8);
    const rects = round(collectPaneRects(equalizeLayout(layout)));
    for (const rect of rects) {
      expect(rect.width).toBeCloseTo(20, 1);
      expect(rect.height).toBe(50);
    }
    expect(rects.map((rect) => rect.left)).toEqual([0, 20, 40, 60, 80, 0, 20, 40, 60, 80]);
  });

  it("gives columns equal widths even when one column is split in two", () => {
    // (a over b) | c — two columns, not three leaves.
    const layout = split("horizontal", split("vertical", pane("a"), pane("b"), 0.2), pane("c"), 0.8);
    expect(round(collectPaneRects(equalizeLayout(layout)))).toEqual([
      { paneId: "a", left: 0, top: 0, width: 50, height: 50 },
      { paneId: "b", left: 0, top: 50, width: 50, height: 50 },
      { paneId: "c", left: 50, top: 0, width: 50, height: 100 },
    ]);
  });

  it("lines nested columns up into a grid", () => {
    // a | (b over (c | d)): three columns in the bottom row, so a gets a third.
    const layout = split(
      "horizontal",
      pane("a"),
      split("vertical", pane("b"), split("horizontal", pane("c"), pane("d"), 0.9), 0.1),
      0.5,
    );
    const rects = round(collectPaneRects(equalizeLayout(layout)));
    expect(rects).toEqual([
      { paneId: "a", left: 0, top: 0, width: 33.33, height: 100 },
      { paneId: "b", left: 33.33, top: 0, width: 66.67, height: 50 },
      { paneId: "c", left: 33.33, top: 50, width: 33.33, height: 50 },
      { paneId: "d", left: 66.67, top: 50, width: 33.33, height: 50 },
    ]);
  });

  it("evens out only what is on the canvas", () => {
    // a | b | c with b minimized: a and c split the row in half.
    const layout = split("horizontal", pane("a"), split("horizontal", pane("b"), pane("c"), 0.3), 0.2);
    const hidden = new Set(["b"]);
    const rects = collectVisiblePaneRects(equalizeLayout(layout, hidden), hidden);
    expect(round(rects)).toEqual([
      { paneId: "a", left: 0, top: 0, width: 50, height: 100 },
      { paneId: "c", left: 50, top: 0, width: 50, height: 100 },
    ]);
    // The split holding the hidden pane keeps its ratio, so b comes back
    // where it was.
    const inner = findLayoutNodeAtPath(equalizeLayout(layout, hidden), [1]);
    expect(inner?.kind === "split" && inner.ratio).toBe(0.3);
  });

  it("leaves a single pane alone and keeps pane data", () => {
    const single: LayoutNode = { kind: "pane", paneId: "a", cwd: "D:\repo" };
    expect(equalizeLayout(single)).toBe(single);
    const layout = split("vertical", single, pane("b"), 0.7);
    expect(findPaneNode(equalizeLayout(layout), "a")).toEqual(single);
  });

  it("knows when there is nothing to equalize", () => {
    expect(isLayoutEqualized(repeatedSplits(4))).toBe(false);
    expect(isLayoutEqualized(equalizeLayout(repeatedSplits(4)))).toBe(true);
    expect(isLayoutEqualized(pane("a"))).toBe(true);
  });

  it("counts panes along a direction", () => {
    const layout = split("horizontal", pane("a"), split("vertical", pane("b"), split("horizontal", pane("c"), pane("d"))));
    expect(countPanesAlong(layout, "horizontal")).toBe(3);
    expect(countPanesAlong(layout, "vertical")).toBe(2);
    expect(countPanesAlong(layout, "horizontal", new Set(["c", "d"]))).toBe(2);
  });
});

describe("divider bounds", () => {
  const pane = (paneId: string): LayoutNode => ({ kind: "pane", paneId });
  const row: LayoutNode = {
    kind: "split",
    direction: "horizontal",
    ratio: 0.5,
    first: pane("a"),
    second: {
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: pane("b"),
      second: pane("c"),
    },
  };

  it("keeps every pane at least the minimum wide on both sides", () => {
    // 1000px, 160px per pane: a needs 160, b+c need 320.
    const bounds = splitRatioBounds(row, 1000, 160);
    expect(bounds.min).toBeCloseTo(0.16, 6);
    expect(bounds.max).toBeCloseTo(0.68, 6);
  });

  it("shares proportionally when the area cannot fit every minimum", () => {
    const bounds = splitRatioBounds(row, 300, 160);
    expect(bounds.min).toBeCloseTo(1 / 3, 6);
    expect(bounds.max).toBeCloseTo(1 / 3, 6);
  });

  it("reads the nested ratios, not just the pane count, of each side", () => {
    // A | (B | C) on a 1200px canvas. The right side was widened to 1000px
    // and its inner divider dragged to its own floor, leaving C at 166px
    // (inner ratio 0.834). Counting B and C as even, the outer divider could
    // shrink that side to 2 × 166 = 332px and C to ~55px.
    const canvas = 1200;
    const minPane = 160 + 6;
    const nested: LayoutNode = {
      kind: "split",
      direction: "horizontal",
      ratio: 1 - 1000 / canvas,
      first: pane("a"),
      second: {
        kind: "split",
        direction: "horizontal",
        ratio: 0.834,
        first: pane("b"),
        second: pane("c"),
      },
    };
    const bounds = splitRatioBounds(nested, canvas, minPane);
    const widths = (ratio: number) =>
      Object.fromEntries(
        collectPaneRects({ ...nested, ratio }).map((rect) => [
          rect.paneId,
          (rect.width / 100) * canvas,
        ]),
      );
    // Dragged all the way right, C still keeps its floor.
    expect(widths(bounds.max).c).toBeGreaterThanOrEqual(minPane - 0.01);
    expect(widths(bounds.max).c).toBeCloseTo(minPane, 1);
    // Dragged all the way left, A keeps its own.
    expect(widths(bounds.min).a).toBeCloseTo(minPane, 1);
  });

  it("measures a side split across the divider by its longest need", () => {
    // a | (b / c): b and c stack, so the right side needs one pane's width
    // whatever their vertical ratio is.
    const stacked: LayoutNode = {
      kind: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: pane("a"),
      second: {
        kind: "split",
        direction: "vertical",
        ratio: 0.9,
        first: pane("b"),
        second: pane("c"),
      },
    };
    expect(splitRatioBounds(stacked, 1000, 160).max).toBeCloseTo(0.84, 6);
  });

  it("gives a minimized pane's room to its sibling when sizing a side", () => {
    // With b off the canvas, c fills the right side on its own: the inner
    // ratio divides nothing on screen and must not inflate the need.
    const bounds = splitRatioBounds(
      { ...row, second: { ...(row.second as Extract<LayoutNode, { kind: "split" }>), ratio: 0.9 } },
      1000,
      160,
      new Set(["b"]),
    );
    expect(bounds.max).toBeCloseTo(0.84, 6);
  });

  it("lets a drag reach ratios below the old 15% floor", () => {
    expect(updateSplitRatioInLayout(row, [], 0.1)).toMatchObject({ ratio: 0.1 });
    expect(updateSplitRatioInLayout(row, [], 0)).toMatchObject({ ratio: 0.02 });
  });
});
