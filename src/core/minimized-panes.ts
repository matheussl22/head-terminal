import { formatActivityDuration } from "./activity-duration";
import type { PaneRuntime } from "./session-manager";

/** A terminal taken off its session's canvas into the session's dock. What
 * its agent did meanwhile lives on the pane's runtime (activity, doneAt,
 * blockedReason) — the same truth the header and the sidebar read. */
export interface MinimizedPane {
  /** When it left the canvas. */
  since: number;
}

export type MinimizedPaneTone =
  | "working"
  | "starting"
  | "approval"
  | "done"
  | "waiting"
  | "idle"
  | "error"
  | "exited"
  | "fallback";

export interface MinimizedPaneStatus {
  tone: MinimizedPaneTone;
  label: string;
  /** How long it has been working, or since it stopped. */
  time?: string;
  /** The card should catch the eye: the agent is blocked on the user, or
   * stopped since it was minimized. */
  attention: boolean;
}

export type MinimizedPaneRuntime = Pick<
  PaneRuntime,
  "activity" | "activitySince" | "blockedReason" | "blockedDetail" | "doneAt" | "agentExitCode"
>;

/** What a minimized terminal's card says about it. */
export function describeMinimizedPane(
  runtime: MinimizedPaneRuntime | undefined,
  minimized: MinimizedPane,
  now: number,
): MinimizedPaneStatus {
  const activity = runtime?.activity ?? "starting";
  const ago = (since: number) => `há ${formatActivityDuration(since, now)}`;
  const stateAgo = runtime ? ago(runtime.activitySince) : undefined;

  switch (activity) {
    case "working":
      return {
        tone: "working",
        label: "Executando",
        time: runtime ? formatActivityDuration(runtime.activitySince, now) : undefined,
        attention: false,
      };
    case "starting":
      return { tone: "starting", label: "Iniciando", attention: false };
    case "waiting_input":
      // Always the user's move: waiting_input is never just a finished turn.
      switch (runtime?.blockedReason) {
        case "approval":
          return { tone: "approval", label: "Pede aprovação", time: stateAgo, attention: true };
        case "question":
          return { tone: "waiting", label: "Fez uma pergunta", time: stateAgo, attention: true };
        case "dialog":
          return { tone: "waiting", label: "Espera confirmação", time: stateAgo, attention: true };
        default:
          return { tone: "waiting", label: "Aguardando", time: stateAgo, attention: true };
      }
    case "idle":
      return runtime?.doneAt !== undefined
        ? { tone: "done", label: "Terminou", time: ago(runtime.doneAt), attention: true }
        : { tone: "idle", label: "Pronto", attention: false };
    case "error":
      return { tone: "error", label: "Erro", time: stateAgo, attention: true };
    case "agent_fallback":
      // Leaving with 0 is the user's own /exit: worth a label, not an alarm.
      return runtime?.agentExitCode === 0
        ? { tone: "fallback", label: "Agent saiu", time: stateAgo, attention: false }
        : { tone: "fallback", label: "Agent caiu", time: stateAgo, attention: true };
    case "exited": {
      const exitedHere = runtime !== undefined && runtime.activitySince >= minimized.since;
      return {
        tone: "exited",
        label: "Encerrado",
        time: exitedHere ? stateAgo : undefined,
        attention: exitedHere,
      };
    }
  }
}

/** The card's clock only ticks while its text counts time. */
export function minimizedPaneTicks(runtime: MinimizedPaneRuntime | undefined): boolean {
  if (!runtime) {
    return false;
  }
  return (
    runtime.activity === "working" ||
    runtime.activity === "waiting_input" ||
    runtime.activity === "error" ||
    runtime.activity === "agent_fallback" ||
    runtime.doneAt !== undefined
  );
}
