import type { PaneProcessInspection } from "../../electron/types/api";
import type { PaneActivity } from "../types/activity";
import type { AgentSession } from "../types/session";
import { isResumableAgent } from "./agent-sessions-bridge";
import { collectPaneIds } from "./session-layout";
import type { PaneRuntime } from "./session-manager";

/**
 * Putting idle sessions to sleep. An agent CLI idling in a session nobody
 * uses still holds hundreds of MB — Claude Code, its MCP servers, the shell
 * around it — and so does its terminal's scrollback. A session left alone
 * long enough is brought back to the state every session but the active one
 * is in right after the app starts: nothing running, each pane set to resume
 * its own conversation (see `hibernateSession` in session-manager.ts).
 * Selecting it starts it again, exactly as after a restart.
 *
 * Only what comes back intact is put to sleep:
 * - agent panes whose conversation the CLI resumes (Claude, Codex, Cursor),
 *   idle at their prompt, with no command left running in the background;
 * - plain shells sitting at their prompt with nothing running under them.
 * A turn in progress, a question waiting for the user, a dev server, a local
 * model or a WSL shell (whose processes Windows cannot see) keep the whole
 * session awake.
 */

/** Why a session or one of its panes stays awake. */
export type HibernationBlocker =
  /** On screen on the desktop. */
  | "active"
  /** Not running: nothing to put to sleep. */
  | "not_spawned"
  /** Used (looked at, typed into, woken) too recently. */
  | "recent"
  /** A profile whose state would not come back (local models, WSL). */
  | "profile"
  /** Working, starting, or waiting on the user. */
  | "busy"
  /** Typed into, but its conversation was never identified: it could not
   * be resumed. */
  | "unanchored"
  /** A phone is looking at it, or the voice is recording into it. */
  | "watched"
  /** Something still runs under it (a dev server, a background command). */
  | "processes";

/** How a pane is checked: an agent may keep its MCP servers, a shell
 * nothing at all. */
export type HibernationPaneKind = "agent" | "shell";

export interface HibernationCandidate {
  sessionId: string;
  panes: Array<{ paneId: string; kind: HibernationPaneKind }>;
}

/** Activities a pane can be put to sleep in. */
const RESTING: ReadonlySet<PaneActivity> = new Set([
  "idle",
  "exited",
  "error",
  "agent_fallback",
]);

// Not in the store: a keystroke must not re-render the app.
const paneInputAt = new Map<string, number>();
const sessionUsedAt = new Map<string, number>();
/** paneId -> id of the pty its current process runs in (a new one per
 * spawn), which is what main knows the process by. */
const panePtyIds = new Map<string, string>();

export function notePanePty(paneId: string, ptyId: string | null): void {
  if (ptyId) panePtyIds.set(paneId, ptyId);
  else panePtyIds.delete(paneId);
}

export function panePtyId(paneId: string): string | undefined {
  return panePtyIds.get(paneId);
}

/** The user typed into the pane (from the desktop or from a phone). */
export function notePaneInput(paneId: string, now = Date.now()): void {
  paneInputAt.set(paneId, now);
}

/** The session was looked at, left, woken or driven from a phone. */
export function noteSessionUsed(sessionId: string, now = Date.now()): void {
  sessionUsedAt.set(sessionId, now);
}

export function lastPaneInputAt(paneId: string): number | undefined {
  return paneInputAt.get(paneId);
}

export function lastSessionUsedAt(sessionId: string): number | undefined {
  return sessionUsedAt.get(sessionId);
}

/** Tests only. */
export function resetHibernationTracking(): void {
  paneInputAt.clear();
  sessionUsedAt.clear();
  panePtyIds.clear();
}

export function paneKind(
  session: Pick<AgentSession, "agentProfileId" | "wslDistro">,
  runtime: Pick<PaneRuntime, "activity"> | undefined,
): HibernationPaneKind | null {
  if (isResumableAgent(session.agentProfileId)) {
    // The agent left and its shell took over: what runs now is a shell.
    return runtime?.activity === "agent_fallback" ? "shell" : "agent";
  }
  if (session.agentProfileId === "shell" && !session.wslDistro) {
    return "shell";
  }
  return null;
}

export interface HibernationView {
  sessions: AgentSession[];
  activeSessionId: string | null;
  spawnedSessionIds: Record<string, boolean>;
  paneRuntime: Record<string, PaneRuntime | undefined>;
  paneResumeAnchors: Record<string, string>;
  voiceRecordingPaneId?: string | null;
  voiceTranscribingPaneId?: string | null;
}

export interface HibernationCheckOptions {
  now: number;
  /** How long it must have been quiet; ignored with `force`. */
  idleMs: number;
  /** Panes a phone is looking at. */
  watchedPaneIds?: ReadonlySet<string>;
  /** Asked for by the user: being on screen or recently used is no
   * objection. What would not come back intact still is. */
  force?: boolean;
}

/**
 * Why `sessionId` must stay awake, or the panes to check under it before it
 * may sleep. Pure: the process check comes after (`processBlocker`).
 */
export function checkSessionHibernation(
  view: HibernationView,
  sessionId: string,
  options: HibernationCheckOptions,
): { blocker: HibernationBlocker; paneId?: string } | HibernationCandidate {
  const session = view.sessions.find((item) => item.id === sessionId);
  if (!session || !view.spawnedSessionIds[sessionId]) {
    return { blocker: "not_spawned" };
  }
  if (!options.force && view.activeSessionId === sessionId) {
    return { blocker: "active" };
  }
  const usedAt = sessionUsedAt.get(sessionId) ?? 0;
  if (!options.force && options.now - usedAt < options.idleMs) {
    return { blocker: "recent" };
  }

  const panes: HibernationCandidate["panes"] = [];
  for (const paneId of collectPaneIds(session.layout)) {
    const runtime = view.paneRuntime[paneId];
    const kind = paneKind(session, runtime);
    if (!kind) {
      return { blocker: "profile", paneId };
    }
    if (!runtime || !RESTING.has(runtime.activity)) {
      return { blocker: "busy", paneId };
    }
    if (
      options.watchedPaneIds?.has(paneId) ||
      view.voiceRecordingPaneId === paneId ||
      view.voiceTranscribingPaneId === paneId
    ) {
      return { blocker: "watched", paneId };
    }
    const inputAt = paneInputAt.get(paneId);
    const quietSince = Math.max(runtime.activitySince, inputAt ?? 0);
    if (!options.force && options.now - quietSince < options.idleMs) {
      return { blocker: "recent", paneId };
    }
    // A conversation the app never identified cannot be resumed; one that
    // was never started (nothing typed yet) has nothing to lose.
    if (
      kind === "agent" &&
      runtime.activity === "idle" &&
      inputAt !== undefined &&
      !view.paneResumeAnchors[paneId]
    ) {
      return { blocker: "unanchored", paneId };
    }
    panes.push({ paneId, kind });
  }
  return { sessionId, panes };
}

export function isHibernationCandidate(
  result: ReturnType<typeof checkSessionHibernation>,
): result is HibernationCandidate {
  return "panes" in result;
}

/** Sessions whose terminals may be put to sleep, before the process check. */
export function findHibernationCandidates(
  view: HibernationView,
  options: HibernationCheckOptions,
): HibernationCandidate[] {
  return view.sessions
    .map((session) => checkSessionHibernation(view, session.id, options))
    .filter(isHibernationCandidate);
}

/**
 * Whether what runs under a pane keeps it awake. A pane without a process
 * (exited, or gone meanwhile) has nothing to lose.
 */
export function processBlocker(
  kind: HibernationPaneKind,
  inspection: PaneProcessInspection | undefined,
): boolean {
  if (!inspection || !inspection.alive) {
    return false;
  }
  return kind === "shell"
    ? inspection.children.length > 0
    : inspection.detachedShells.length > 0;
}
