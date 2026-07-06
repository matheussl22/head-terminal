// Padrão FLIP via WAAPI: itens marcados com data-session-id deslizam da
// posição anterior para a nova quando a lista reordena.
export function flipAnimate(
  container: HTMLElement,
  prevTops: Map<string, number>,
  duration = 240,
): Map<string, number> {
  const reduced =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const nextTops = new Map<string, number>();

  for (const item of container.querySelectorAll<HTMLElement>(
    "[data-session-id]",
  )) {
    const id = item.dataset.sessionId as string;
    const top = item.getBoundingClientRect().top;
    nextTops.set(id, top);

    const prev = prevTops.get(id);
    if (!reduced && prev !== undefined && Math.abs(prev - top) > 1) {
      item.animate(
        [
          { transform: `translateY(${prev - top}px)` },
          { transform: "translateY(0)" },
        ],
        { duration, easing: "ease-out" },
      );
    }
  }

  return nextTops;
}
