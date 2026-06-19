import type { LayoutNode, SplitDirection } from "../types/session";

export interface PaneRect {
  paneId: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface LayoutDividerDescriptor {
  path: number[];
  direction: SplitDirection;
  ratio: number;
  top: number;
  left: number;
  width: number;
  height: number;
}

type Bounds = {
  top: number;
  left: number;
  width: number;
  height: number;
};

const FULL_BOUNDS: Bounds = { top: 0, left: 0, width: 100, height: 100 };

export function createPaneId(): string {
  return crypto.randomUUID();
}

export function createInitialLayout(paneId: string): LayoutNode {
  return { kind: "pane", paneId };
}

export function collectPaneIds(layout: LayoutNode): string[] {
  if (layout.kind === "pane") {
    return [layout.paneId];
  }

  return [
    ...collectPaneIds(layout.first),
    ...collectPaneIds(layout.second),
  ];
}

export function splitPaneInLayout(
  layout: LayoutNode,
  targetPaneId: string,
  direction: SplitDirection,
  newPaneId: string,
): LayoutNode {
  if (layout.kind === "pane") {
    if (layout.paneId !== targetPaneId) {
      return layout;
    }

    return {
      kind: "split",
      direction,
      ratio: 0.5,
      first: layout,
      second: { kind: "pane", paneId: newPaneId },
    };
  }

  return {
    ...layout,
    first: splitPaneInLayout(layout.first, targetPaneId, direction, newPaneId),
    second: splitPaneInLayout(layout.second, targetPaneId, direction, newPaneId),
  };
}

export function collectPaneRects(
  node: LayoutNode,
  bounds: Bounds = FULL_BOUNDS,
): PaneRect[] {
  if (node.kind === "pane") {
    return [{ paneId: node.paneId, ...bounds }];
  }

  const { direction, ratio, first, second } = node;

  if (direction === "horizontal") {
    const firstWidth = bounds.width * ratio;
    return [
      ...collectPaneRects(first, { ...bounds, width: firstWidth }),
      ...collectPaneRects(second, {
        ...bounds,
        left: bounds.left + firstWidth,
        width: bounds.width - firstWidth,
      }),
    ];
  }

  const firstHeight = bounds.height * ratio;
  return [
    ...collectPaneRects(first, { ...bounds, height: firstHeight }),
    ...collectPaneRects(second, {
      ...bounds,
      top: bounds.top + firstHeight,
      height: bounds.height - firstHeight,
    }),
  ];
}

export function collectSplitDividers(
  node: LayoutNode,
  bounds: Bounds = FULL_BOUNDS,
  path: number[] = [],
): LayoutDividerDescriptor[] {
  if (node.kind === "pane") {
    return [];
  }

  const { direction, ratio, first, second } = node;
  const divider: LayoutDividerDescriptor = {
    path,
    direction,
    ratio,
    ...bounds,
  };

  if (direction === "horizontal") {
    const firstWidth = bounds.width * ratio;
    return [
      divider,
      ...collectSplitDividers(
        first,
        { ...bounds, width: firstWidth },
        [...path, 0],
      ),
      ...collectSplitDividers(
        second,
        {
          ...bounds,
          left: bounds.left + firstWidth,
          width: bounds.width - firstWidth,
        },
        [...path, 1],
      ),
    ];
  }

  const firstHeight = bounds.height * ratio;
  return [
    divider,
    ...collectSplitDividers(
      first,
      { ...bounds, height: firstHeight },
      [...path, 0],
    ),
    ...collectSplitDividers(
      second,
      {
        ...bounds,
        top: bounds.top + firstHeight,
        height: bounds.height - firstHeight,
      },
      [...path, 1],
    ),
  ];
}

export function updateSplitRatioInLayout(
  layout: LayoutNode,
  path: number[],
  ratio: number,
): LayoutNode {
  if (path.length === 0) {
    if (layout.kind !== "split") {
      return layout;
    }

    return {
      ...layout,
      ratio: Math.min(0.85, Math.max(0.15, ratio)),
    };
  }

  if (layout.kind === "pane") {
    return layout;
  }

  const [head, ...tail] = path;

  if (head === 0) {
    return {
      ...layout,
      first: updateSplitRatioInLayout(layout.first, tail, ratio),
    };
  }

  return {
    ...layout,
    second: updateSplitRatioInLayout(layout.second, tail, ratio),
  };
}
