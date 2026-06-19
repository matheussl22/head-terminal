import { useCallback, type CSSProperties } from "react";

import { useSessionStore } from "../../core/session-manager";
import type { LayoutDividerDescriptor } from "../../core/session-layout";

interface LayoutDividersProps {
  sessionId: string;
  dividers: LayoutDividerDescriptor[];
}

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

      const snapRatio = (ratio: number): number => {
        const clamped = Math.min(0.85, Math.max(0.15, ratio));
        const snaps = [0.33, 0.5, 0.66];
        for (const snap of snaps) {
          if (Math.abs(clamped - snap) < 0.04) {
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
