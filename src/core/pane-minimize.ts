import { useSessionStore } from "./session-manager";
import { getTerminal } from "./terminal-registry";

/**
 * Minimizing and restoring a terminal, with a bit of motion: a bare outline
 * of the pane (a "ghost") flies between the terminal's box and its card in
 * the session's dock. The real elements never move — the pane is parked and
 * the card appears in the same commit — so the animation is decoration only
 * and cannot leave the layout half-way.
 */

type MotionKind = "minimize" | "restore";

interface MotionOrigin {
  kind: MotionKind;
  rect: DOMRect;
  at: number;
}

const GHOST_MS = 260;
/** An origin nothing landed on quickly (the store refused the change, the
 * target never showed up) is stale and must not launch a later flight. */
const ORIGIN_TTL_MS = 800;

const origins = new Map<string, MotionOrigin>();

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Hidden sessions and parked panes sit far off-screen: nothing to fly from. */
function isOnScreen(rect: DOMRect): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight
  );
}

function noteOrigin(paneId: string, kind: MotionKind, element: Element | null): void {
  const rect = element?.getBoundingClientRect();
  if (rect && isOnScreen(rect)) {
    origins.set(paneId, { kind, rect, at: performance.now() });
  } else {
    origins.delete(paneId);
  }
}

// Pane ids are UUIDs: safe inside a quoted attribute selector as they are.
function paneShellElement(paneId: string): HTMLElement | null {
  return document.querySelector(`[data-pane-shell="${paneId}"]`);
}

function minimizedCardElement(paneId: string): HTMLElement | null {
  return document.querySelector(`[data-minimized-pane="${paneId}"]`);
}

export function minimizePaneWithMotion(paneId: string): void {
  noteOrigin(paneId, "minimize", paneShellElement(paneId));
  useSessionStore.getState().minimizePane(paneId);
}

export function restorePaneWithMotion(paneId: string): void {
  noteOrigin(paneId, "restore", minimizedCardElement(paneId));
  useSessionStore.getState().restorePane(paneId);
}

/**
 * Brings a terminal to the front wherever it is — another session, the dock,
 * parked behind a zoomed sibling — and hands it the keyboard. The toolbar
 * chips and the sidebar's pane dots jump through here, so "1 aguardando"
 * always ends on the pane asking, not on one hiding it. Its "Concluído" is
 * read only because the pane is then on screen.
 *
 * The focus is given again on the next frame even when the pane already was
 * the active one: activePaneId does not change then, AppShell does not
 * refocus, and the keyboard would stay on the chip that was clicked (Enter
 * would click it again instead of answering the agent).
 */
export function revealPane(paneId: string): void {
  const state = useSessionStore.getState();
  if (state.minimizedPanes[paneId]) {
    restorePaneWithMotion(paneId);
  } else {
    state.restorePane(paneId);
  }
  requestAnimationFrame(() => getTerminal(paneId)?.terminal.focus());
}

/** Minimizes the active terminal, or brings it back when it is the one
 * minimized (every terminal of the session in the dock). */
export function toggleActivePaneMinimized(): void {
  const { activePaneId, minimizedPanes } = useSessionStore.getState();
  if (!activePaneId) {
    return;
  }
  if (minimizedPanes[activePaneId]) {
    restorePaneWithMotion(activePaneId);
  } else {
    minimizePaneWithMotion(activePaneId);
  }
}

/** Called by the element a motion ends on — the card after minimizing, the
 * pane after restoring — once it is laid out, before paint. */
export function landPaneMotion(
  paneId: string,
  kind: MotionKind,
  target: HTMLElement | null,
): void {
  const origin = origins.get(paneId);
  if (!origin || origin.kind !== kind) {
    return;
  }
  origins.delete(paneId);

  if (
    !target ||
    typeof target.animate !== "function" ||
    performance.now() - origin.at > ORIGIN_TTL_MS ||
    prefersReducedMotion()
  ) {
    return;
  }

  const to = target.getBoundingClientRect();
  if (!isOnScreen(to)) {
    return;
  }

  flyGhost(origin.rect, to, kind);
  // The real element shows up as the ghost lands on it.
  target.animate(
    [{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }],
    { duration: GHOST_MS + 90, easing: "ease-out" },
  );
}

function boxOf(rect: DOMRect): Record<"left" | "top" | "width" | "height", string> {
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

function flyGhost(from: DOMRect, to: DOMRect, kind: MotionKind): void {
  const ghost = document.createElement("div");
  ghost.className = `pane-motion-ghost pane-motion-ghost--${kind}`;
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, boxOf(from));
  document.body.appendChild(ghost);

  const animation = ghost.animate(
    [
      { ...boxOf(from), opacity: kind === "minimize" ? 1 : 0.5 },
      { ...boxOf(to), opacity: kind === "minimize" ? 0.4 : 1 },
    ],
    {
      duration: GHOST_MS,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      fill: "forwards",
    },
  );
  const remove = () => ghost.remove();
  animation.onfinish = remove;
  animation.oncancel = remove;
  // A timeline that never advances (window minimized mid-flight) must not
  // leave the outline stuck over the app.
  window.setTimeout(remove, GHOST_MS + 250);
}
