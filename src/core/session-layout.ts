import type {
  LayoutNode,
  PaneLayoutNode,
  SplitDirection,
  WorktreeRef,
} from "../types/session";

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

const NO_HIDDEN_PANES: ReadonlySet<string> = new Set();

/** True when every pane under this node is off the canvas. */
function isSubtreeHidden(node: LayoutNode, hidden: ReadonlySet<string>): boolean {
  if (node.kind === "pane") {
    return hidden.has(node.paneId);
  }
  return isSubtreeHidden(node.first, hidden) && isSubtreeHidden(node.second, hidden);
}

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
  newPaneCwd?: string,
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
      second: {
        kind: "pane",
        paneId: newPaneId,
        ...(newPaneCwd ? { cwd: newPaneCwd } : {}),
      },
    };
  }

  return {
    ...layout,
    first: splitPaneInLayout(layout.first, targetPaneId, direction, newPaneId, newPaneCwd),
    second: splitPaneInLayout(layout.second, targetPaneId, direction, newPaneId, newPaneCwd),
  };
}

export function findPaneNode(
  layout: LayoutNode,
  paneId: string,
): PaneLayoutNode | null {
  if (layout.kind === "pane") {
    return layout.paneId === paneId ? layout : null;
  }
  return findPaneNode(layout.first, paneId) ?? findPaneNode(layout.second, paneId);
}

/** Rewrites every pane node; the split structure stays as it is. */
export function mapPaneNodes(
  layout: LayoutNode,
  transform: (pane: PaneLayoutNode) => PaneLayoutNode,
): LayoutNode {
  if (layout.kind === "pane") {
    return transform(layout);
  }
  return {
    ...layout,
    first: mapPaneNodes(layout.first, transform),
    second: mapPaneNodes(layout.second, transform),
  };
}

/** Gives one pane its own working directory; `undefined` puts it back on the session's.
 *
 * Sai junto a marca de worktree: ela só vale enquanto o terminal está na árvore
 * que o app criou para ele, e trocar a pasta na mão é justamente sair de lá. */
export function setPaneCwdInLayout(
  layout: LayoutNode,
  paneId: string,
  cwd: string | undefined,
): LayoutNode {
  return mapPaneNodes(layout, (pane) => {
    if (pane.paneId !== paneId) {
      return pane;
    }
    const { cwd: _previous, worktree: _worktree, ...rest } = pane;
    return cwd ? { ...rest, cwd } : rest;
  });
}

/** Move um terminal para a árvore isolada que acabou de ser criada para ele. */
export function setPaneWorktreeInLayout(
  layout: LayoutNode,
  paneId: string,
  worktree: WorktreeRef,
): LayoutNode {
  return mapPaneNodes(layout, (pane) =>
    pane.paneId === paneId
      ? { ...pane, cwd: worktree.path, worktree }
      : pane,
  );
}

/** As árvores que o app criou para terminais desta sessão. */
export function collectPaneWorktrees(layout: LayoutNode): WorktreeRef[] {
  if (layout.kind === "pane") {
    return layout.worktree ? [layout.worktree] : [];
  }
  return [
    ...collectPaneWorktrees(layout.first),
    ...collectPaneWorktrees(layout.second),
  ];
}

/** Where this pane's terminal runs: its own folder, else the session's default. */
export function resolvePaneCwd(
  session: { cwd: string; layout: LayoutNode },
  paneId: string,
): string {
  return findPaneNode(session.layout, paneId)?.cwd ?? session.cwd;
}

export function closePaneInLayout(
  layout: LayoutNode,
  targetPaneId: string,
): LayoutNode {
  if (layout.kind === "pane") {
    return layout;
  }

  if (layout.first.kind === "pane" && layout.first.paneId === targetPaneId) {
    return layout.second;
  }

  if (layout.second.kind === "pane" && layout.second.paneId === targetPaneId) {
    return layout.first;
  }

  return {
    ...layout,
    first: closePaneInLayout(layout.first, targetPaneId),
    second: closePaneInLayout(layout.second, targetPaneId),
  };
}

export function collectPaneRects(
  node: LayoutNode,
  bounds: Bounds = FULL_BOUNDS,
  hidden: ReadonlySet<string> = NO_HIDDEN_PANES,
): PaneRect[] {
  if (node.kind === "pane") {
    return hidden.has(node.paneId) ? [] : [{ paneId: node.paneId, ...bounds }];
  }

  const { direction, ratio, first, second } = node;

  // A side with nothing left on the canvas gives all of its room to the other
  // one, as if it had been closed — but the split stays in the tree, so the
  // pane comes back exactly where it was.
  if (isSubtreeHidden(first, hidden)) {
    return collectPaneRects(second, bounds, hidden);
  }
  if (isSubtreeHidden(second, hidden)) {
    return collectPaneRects(first, bounds, hidden);
  }

  if (direction === "horizontal") {
    const firstWidth = bounds.width * ratio;
    return [
      ...collectPaneRects(first, { ...bounds, width: firstWidth }, hidden),
      ...collectPaneRects(
        second,
        {
          ...bounds,
          left: bounds.left + firstWidth,
          width: bounds.width - firstWidth,
        },
        hidden,
      ),
    ];
  }

  const firstHeight = bounds.height * ratio;
  return [
    ...collectPaneRects(first, { ...bounds, height: firstHeight }, hidden),
    ...collectPaneRects(
      second,
      {
        ...bounds,
        top: bounds.top + firstHeight,
        height: bounds.height - firstHeight,
      },
      hidden,
    ),
  ];
}

/** Where the panes still on the canvas go when the `hidden` ones (minimized)
 * leave it. Hidden panes get no rect. */
export function collectVisiblePaneRects(
  layout: LayoutNode,
  hidden: ReadonlySet<string>,
): PaneRect[] {
  return collectPaneRects(layout, FULL_BOUNDS, hidden);
}

export function collectSplitDividers(
  node: LayoutNode,
  bounds: Bounds = FULL_BOUNDS,
  path: number[] = [],
  hidden: ReadonlySet<string> = NO_HIDDEN_PANES,
): LayoutDividerDescriptor[] {
  if (node.kind === "pane") {
    return [];
  }

  // A split with one side off the canvas divides nothing on screen. The side
  // left keeps its path in the real tree, so dragging one of its dividers
  // still updates the right ratio.
  if (isSubtreeHidden(node.first, hidden)) {
    return collectSplitDividers(node.second, bounds, [...path, 1], hidden);
  }
  if (isSubtreeHidden(node.second, hidden)) {
    return collectSplitDividers(node.first, bounds, [...path, 0], hidden);
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
        hidden,
      ),
      ...collectSplitDividers(
        second,
        {
          ...bounds,
          left: bounds.left + firstWidth,
          width: bounds.width - firstWidth,
        },
        [...path, 1],
        hidden,
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
      hidden,
    ),
    ...collectSplitDividers(
      second,
      {
        ...bounds,
        top: bounds.top + firstHeight,
        height: bounds.height - firstHeight,
      },
      [...path, 1],
      hidden,
    ),
  ];
}

/** The dividers between the panes still on the canvas (see
 * `collectVisiblePaneRects`). */
export function collectVisibleSplitDividers(
  layout: LayoutNode,
  hidden: ReadonlySet<string>,
): LayoutDividerDescriptor[] {
  return collectSplitDividers(layout, FULL_BOUNDS, [], hidden);
}

/** A split never hands a side less than this share, whatever it is told. The
 * floor that matters is in pixels and depends on how many panes each side
 * holds (see `splitRatioBounds`, enforced while dragging); this one only keeps
 * a ratio sane. It has to stay well under 1/10: equalizing a row of ten panes
 * gives the first split 0.1. */
const MIN_SPLIT_RATIO = 0.02;

function clampSplitRatio(ratio: number): number {
  return Math.min(1 - MIN_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
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
      ratio: clampSplitRatio(ratio),
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

/** The node a divider's `path` points at (0 = first, 1 = second). */
export function findLayoutNodeAtPath(
  layout: LayoutNode,
  path: number[],
): LayoutNode | null {
  let node: LayoutNode = layout;
  for (const step of path) {
    if (node.kind !== "split") {
      return null;
    }
    node = step === 0 ? node.first : node.second;
  }
  return node;
}

/**
 * How many panes this subtree lines up along `direction`: its columns for
 * "horizontal", its rows for "vertical". Splits in that direction add their
 * sides up; splits across it stack them, so the busier side counts. Panes off
 * the canvas (minimized) count for nothing, like they take no room.
 */
export function countPanesAlong(
  node: LayoutNode,
  direction: SplitDirection,
  hidden: ReadonlySet<string> = NO_HIDDEN_PANES,
): number {
  if (node.kind === "pane") {
    return hidden.has(node.paneId) ? 0 : 1;
  }
  const first = countPanesAlong(node.first, direction, hidden);
  const second = countPanesAlong(node.second, direction, hidden);
  return node.direction === direction ? first + second : Math.max(first, second);
}

/**
 * Every split shares its room by how many panes each side lines up in the
 * split's direction, so the panes of a row get the same width and those of a
 * column the same height — a chain of same-direction splits (what "dividir ao
 * lado" repeated produces: 1/2, 1/4, 1/8…) comes out even, and a grid keeps
 * its columns aligned. For a plain chain this is leaves(first) / leaves(node).
 *
 * A split whose side is entirely off the canvas keeps its ratio: on screen it
 * divides nothing, and the pane comes back exactly where it was.
 */
export function equalizeLayout(
  layout: LayoutNode,
  hidden: ReadonlySet<string> = NO_HIDDEN_PANES,
): LayoutNode {
  if (layout.kind === "pane") {
    return layout;
  }
  const first = countPanesAlong(layout.first, layout.direction, hidden);
  const second = countPanesAlong(layout.second, layout.direction, hidden);
  return {
    ...layout,
    ratio: first > 0 && second > 0 ? first / (first + second) : layout.ratio,
    first: equalizeLayout(layout.first, hidden),
    second: equalizeLayout(layout.second, hidden),
  };
}

/** Whether equalizing would move anything (ratios compared to 0.1%). */
export function isLayoutEqualized(
  layout: LayoutNode,
  hidden: ReadonlySet<string> = NO_HIDDEN_PANES,
): boolean {
  const equalized = equalizeLayout(layout, hidden);
  const same = (a: LayoutNode, b: LayoutNode): boolean => {
    if (a.kind === "pane" || b.kind === "pane") {
      return a.kind === b.kind;
    }
    return (
      Math.abs(a.ratio - b.ratio) < 0.001 && same(a.first, b.first) && same(a.second, b.second)
    );
  };
  return same(layout, equalized);
}

/**
 * How long this subtree must be along `direction` for none of its panes to
 * get under `minPanePx`, given the ratios its splits have now. A split in that
 * direction hands each side its ratio of the room, so the side that is
 * squeezed hardest sets the need: a pane left with 17% of its side needs that
 * side six times its own minimum, not twice. Splits across it stack their
 * sides, so the longer need wins. Panes off the canvas take no room.
 */
function minExtentAlong(
  node: LayoutNode,
  direction: SplitDirection,
  minPanePx: number,
  hidden: ReadonlySet<string>,
): number {
  if (node.kind === "pane") {
    return hidden.has(node.paneId) ? 0 : minPanePx;
  }
  const first = minExtentAlong(node.first, direction, minPanePx, hidden);
  const second = minExtentAlong(node.second, direction, minPanePx, hidden);
  if (node.direction !== direction) {
    return Math.max(first, second);
  }
  // A side entirely off the canvas divides nothing: the other takes it all.
  if (first === 0) {
    return second;
  }
  if (second === 0) {
    return first;
  }
  return Math.max(first / node.ratio, second / (1 - node.ratio));
}

/**
 * The ratios a divider may take so that no pane on either side gets smaller
 * than `minPanePx` (the pane's box, gap included) in an area `areaPx` long.
 * Nested splits keep their ratios while this one moves, so each side's need
 * comes from how its panes actually share it, not from counting them as if
 * they were even. When the area is too small for both sides, each side gets
 * room in proportion to what it needs and the divider stays put there.
 */
export function splitRatioBounds(
  split: LayoutNode,
  areaPx: number,
  minPanePx: number,
  hidden: ReadonlySet<string> = NO_HIDDEN_PANES,
): { min: number; max: number } {
  if (split.kind !== "split" || areaPx <= 0) {
    return { min: MIN_SPLIT_RATIO, max: 1 - MIN_SPLIT_RATIO };
  }
  const firstNeed = Math.max(
    minPanePx,
    minExtentAlong(split.first, split.direction, minPanePx, hidden),
  );
  const secondNeed = Math.max(
    minPanePx,
    minExtentAlong(split.second, split.direction, minPanePx, hidden),
  );
  if (firstNeed + secondNeed >= areaPx) {
    const ratio = clampSplitRatio(firstNeed / (firstNeed + secondNeed));
    return { min: ratio, max: ratio };
  }
  return {
    min: clampSplitRatio(firstNeed / areaPx),
    max: clampSplitRatio(1 - secondNeed / areaPx),
  };
}
