// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { flipAnimate } from "./flip-animate";

function makeItem(id: string, top: number) {
  const el = document.createElement("li");
  el.dataset.sessionId = id;
  el.getBoundingClientRect = () => ({ top }) as DOMRect;
  el.animate = vi.fn() as unknown as typeof el.animate;
  return el;
}

describe("flipAnimate", () => {
  it("anima quem mudou de posição e ignora quem ficou parado", () => {
    const list = document.createElement("ul");
    const moved = makeItem("a", 100);
    const still = makeItem("b", 50);
    list.append(moved, still);

    const next = flipAnimate(
      list,
      new Map([
        ["a", 0],
        ["b", 50],
      ]),
    );

    expect(moved.animate).toHaveBeenCalledOnce();
    expect(still.animate).not.toHaveBeenCalled();
    expect(next.get("a")).toBe(100);
  });

  it("não anima no primeiro render (sem posições anteriores)", () => {
    const list = document.createElement("ul");
    const item = makeItem("a", 100);
    list.append(item);

    flipAnimate(list, new Map());

    expect(item.animate).not.toHaveBeenCalled();
  });
});
