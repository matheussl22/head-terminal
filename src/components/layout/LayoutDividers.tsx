import { useCallback, type CSSProperties } from "react";

import { useSessionStore } from "../../core/session-manager";
import {
  collectPaneIds,
  countPanesAlong,
  findLayoutNodeAtPath,
  splitRatioBounds,
  type LayoutDividerDescriptor,
} from "../../core/session-layout";

interface LayoutDividersProps {
  sessionId: string;
  dividers: LayoutDividerDescriptor[];
}

/** No pane gets dragged thinner or shorter than this: enough for the header
 * to keep its agent chip, label, status and "⋯" menu, and for a few columns
 * or rows of terminal. Measured on the pane's box, gap included. */
const MIN_PANE_WIDTH_PX = 160;
const MIN_PANE_HEIGHT_PX = 90;
const PANE_GAP_PX = 6;

/** Ratios the divider sticks to when dropped close enough. */
const SNAP_RATIOS = [1 / 3, 0.5, 2 / 3];
const SNAP_DISTANCE = 0.04;

function dividerKey(path: number[]): string {
  return path.join("-");
}

function dividerStyle(divider: LayoutDividerDescriptor): CSSProperties {
  if (divider.direction === "horizontal") {
    const position = divider.left + divider.width * divider.ratio;

    return {
      left: `${position}%`,
      top: `${divider.top}%`,
      width: "4px",
      height: `${divider.height}%`,
      transform: "translateX(-50%)",
      cursor: "col-resize",
    };
  }

  const position = divider.top + divider.height * divider.ratio;

  return {
    top: `${position}%`,
    left: `${divider.left}%`,
    height: "4px",
    width: `${divider.width}%`,
    transform: "translateY(-50%)",
    cursor: "row-resize",
  };
}

export function LayoutDividers({ sessionId, dividers }: LayoutDividersProps) {
  const updateSplitRatio = useSessionStore((state) => state.updateSplitRatio);

  const onPointerDown = useCallback(
    (divider: LayoutDividerDescriptor, event: React.PointerEvent) => {
      event.preventDefault();

      const canvas = event.currentTarget.parentElement;
      if (!canvas) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const isHorizontal = divider.direction === "horizontal";
      const areaLeft = rect.left + (divider.left / 100) * rect.width;
      const areaTop = rect.top + (divider.top / 100) * rect.height;
      const areaSize = isHorizontal
        ? (divider.width / 100) * rect.width
        : (divider.height / 100) * rect.height;
      const areaStart = isHorizontal ? areaLeft : areaTop;

      // The floor is per pane, so a side holding a row of four needs four
      // times the room — more when its own dividers left one of them thin:
      // a single relative clamp let a divider squeeze a stack of panes into
      // slivers, or refused to move one next to a single pane. Minimized
      // panes take no room and don't count.
      const state = useSessionStore.getState();
      const layout = state.sessions.find((session) => session.id === sessionId)?.layout;
      const split = layout ? findLayoutNodeAtPath(layout, divider.path) : null;
      const hidden = new Set(
        layout ? collectPaneIds(layout).filter((paneId) => state.minimizedPanes[paneId]) : [],
      );
      const floor = split
        ? splitRatioBounds(
            split,
            areaSize,
            (isHorizontal ? MIN_PANE_WIDTH_PX : MIN_PANE_HEIGHT_PX) + PANE_GAP_PX,
            hidden,
          )
        : { min: 0.15, max: 0.85 };
      // A layout that already breaks the floor (a side crammed by earlier
      // splits) is not yanked into place on the first pixel of a drag: the
      // divider only follows the pointer, and just can't make it worse.
      const bounds = {
        min: Math.min(floor.min, divider.ratio),
        max: Math.max(floor.max, divider.ratio),
      };
      // Dropping near the even split (what "distribuir igualmente" gives)
      // snaps to it, like the thirds and the half.
      const snaps =
        split?.kind === "split"
          ? [
              ...SNAP_RATIOS,
              countPanesAlong(split.first, split.direction, hidden) /
                Math.max(
                  1,
                  countPanesAlong(split.first, split.direction, hidden) +
                    countPanesAlong(split.second, split.direction, hidden),
                ),
            ]
          : SNAP_RATIOS;

      const snapRatio = (ratio: number): number => {
        const clamped = Math.min(bounds.max, Math.max(bounds.min, ratio));
        for (const snap of snaps) {
          if (
            Math.abs(clamped - snap) < SNAP_DISTANCE &&
            snap >= bounds.min &&
            snap <= bounds.max
          ) {
            return snap;
          }
        }
        return clamped;
      };

      const onMove = (moveEvent: PointerEvent) => {
        const pointer = isHorizontal ? moveEvent.clientX : moveEvent.clientY;
        const nextRatio = snapRatio((pointer - areaStart) / areaSize);
        updateSplitRatio(sessionId, divider.path, nextRatio, {
          persist: false,
        });
      };

      const onUp = (upEvent: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);

        const pointer = isHorizontal ? upEvent.clientX : upEvent.clientY;
        const nextRatio = snapRatio((pointer - areaStart) / areaSize);
        updateSplitRatio(sessionId, divider.path, nextRatio, {
          persist: true,
        });
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [sessionId, updateSplitRatio],
  );

  return (
    <>
      {dividers.map((divider) => (
        <div
          key={dividerKey(divider.path)}
          className="layout-divider layout-divider--draggable"
          style={dividerStyle(divider)}
          onPointerDown={(event) => onPointerDown(divider, event)}
          role="separator"
          aria-orientation={
            divider.direction === "horizontal" ? "vertical" : "horizontal"
          }
        />
      ))}
    </>
  );
}
