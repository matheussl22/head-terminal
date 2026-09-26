import { formatActivityDuration } from "./activity-duration";
import type { PaneRuntime } from "./session-manager";
import { BLOCKED_REASON_LABEL } from "../types/activity";

/**
 * What the UI shows for a pane or a session. The detector only knows what the
 * agent is doing (PaneActivity); this adds what the *user* cares about when
 * many terminals are open: whether a finished turn has been seen yet
 * ("done") and whether a session was never started ("dormant").
 */
export type PaneStatusTone =
  | "starting"
  | "idle"
  | "working"
  | "waiting"
  | "done"
  | "error"
  | "fallback"
  | "exited"
  | "dormant";

export const TONE_LABEL: Record<PaneStatusTone, string> = {
  starting: "Iniciando",
  idle: "Pronto",
  working: "Executando",
  waiting: "Aguardando",
  done: "Concluído",
  error: "Erro",
  fallback: "Shell",
  exited: "Encerrado",
  dormant: "Não iniciada",
};

/** Session order: what needs the user first, then work, then news, then calm. */
export const TONE_PRIORITY: Record<PaneStatusTone, number> = {
  waiting: 9,
  error: 8,
  fallback: 7,
  working: 6,
  done: 5,
  starting: 4,
  idle: 3,
  exited: 2,
  dormant: 1,
};

/** Tones that should catch the eye in a crowded grid or sidebar. */
export const ATTENTION_TONES: ReadonlySet<PaneStatusTone> = new Set([
  "waiting",
  "error",
  "fallback",
  "done",
]);

/** Tones whose "há X" keeps counting and deserves a ticking clock. */
export const TICKING_TONES: ReadonlySet<PaneStatusTone> = new Set([
  "working",
  "waiting",
  "done",
  "error",
  "fallback",
]);

export type PaneStatusRuntime = Pick<
  PaneRuntime,
  "activity" | "activitySince" | "blockedReason" | "blockedDetail" | "doneAt" | "agentExitCode"
>;

export interface PaneStatusView {
  tone: PaneStatusTone;
  /** Short chip text: "Executando", "Aguardando", "Concluído"… */
  label: string;
  /** Tooltip sentence, without the elapsed time (see formatStatusDetail). */
  detail: string;
  attention: boolean;
  /** When the current tone started, for "há X". */
  since?: number;
}

export function paneStatusTone(runtime: PaneStatusRuntime | undefined): PaneStatusTone {
  const activity = runtime?.activity ?? "starting";
  switch (activity) {
    case "waiting_input":
      return "waiting";
    case "agent_fallback":
      return "fallback";
    case "idle":
      return runtime?.doneAt !== undefined ? "done" : "idle";
    default:
      return activity;
  }
}

function describeDetail(tone: PaneStatusTone, runtime: PaneStatusRuntime | undefined): string {
  switch (tone) {
    case "waiting": {
      const reason = runtime?.blockedReason
        ? BLOCKED_REASON_LABEL[runtime.blockedReason]
        : "espera sua resposta";
      const what = runtime?.blockedDetail ? ` (${runtime.blockedDetail})` : "";
      return `Aguardando você: ${reason}${what}`;
    }
    case "working":
      return "Executando";
    case "done":
      return "Concluído — terminou enquanto você não estava olhando";
    case "idle":
      return "Pronto — nada pendente";
    case "starting":
      return "Iniciando";
    case "error":
      return "O terminal encontrou um erro";
    case "fallback":
      return runtime?.agentExitCode !== undefined && runtime.agentExitCode !== 0
        ? `O agent caiu (código ${runtime.agentExitCode}) — shell ativo`
        : "O agent saiu — shell ativo";
    case "exited":
      return "Processo encerrado";
    case "dormant":
      return "Sessão ainda não iniciada — abre ao selecionar";
  }
}

function toneSince(tone: PaneStatusTone, runtime: PaneStatusRuntime | undefined): number | undefined {
  if (!runtime || !TICKING_TONES.has(tone)) {
    return undefined;
  }
  return tone === "done" ? runtime.doneAt : runtime.activitySince;
}

export function describePaneStatus(runtime: PaneStatusRuntime | undefined): PaneStatusView {
  const tone = paneStatusTone(runtime);
  // An agent the user closed on purpose (/exit, exit code 0) left a working
  // shell behind — nothing to be alarmed about.
  const voluntaryExit = tone === "fallback" && runtime?.agentExitCode === 0;
  return {
    tone,
    label: TONE_LABEL[tone],
    detail: describeDetail(tone, runtime),
    attention: ATTENTION_TONES.has(tone) && !voluntaryExit,
    since: toneSince(tone, runtime),
  };
}

/** "Aguardando você: pede aprovação (Bash) · há 2m" */
export function formatStatusDetail(view: PaneStatusView, now = Date.now()): string {
  return view.since !== undefined
    ? `${view.detail} · há ${formatActivityDuration(view.since, now)}`
    : view.detail;
}

/** "Executando há 3m" / "Pronto" */
export function formatStatusLine(view: PaneStatusView, now = Date.now()): string {
  return view.since !== undefined
    ? `${view.label} há ${formatActivityDuration(view.since, now)}`
    : view.label;
}

export interface SessionStatusView extends PaneStatusView {
  /** How many panes are in each tone. */
  counts: Partial<Record<PaneStatusTone, number>>;
  paneCount: number;
  /** "1 aguardando · 3 executando" when more than one pane has something to
   * say; empty otherwise. */
  summary: string;
}

const SUMMARY_TONES: PaneStatusTone[] = ["waiting", "error", "fallback", "working", "done"];

function summaryWord(tone: PaneStatusTone, count: number): string {
  switch (tone) {
    case "waiting":
      return "aguardando";
    case "working":
      return "executando";
    case "done":
      return count === 1 ? "concluído" : "concluídos";
    case "error":
      return count === 1 ? "erro" : "erros";
    case "fallback":
      return "shell";
    default:
      return TONE_LABEL[tone].toLowerCase();
  }
}

export function summarizeToneCounts(counts: Partial<Record<PaneStatusTone, number>>): string {
  const tones = SUMMARY_TONES.filter((tone) => (counts[tone] ?? 0) > 0);
  // Only when more than one pane has something to say: "1 executando" next
  // to three idle panes repeats the label, "2 executando" does not.
  const speaking = tones.reduce((total, tone) => total + (counts[tone] ?? 0), 0);
  if (speaking < 2) {
    return "";
  }
  return tones.map((tone) => `${counts[tone]} ${summaryWord(tone, counts[tone] ?? 0)}`).join(" · ");
}

/** How loudly a pane speaks for its session. A shell left behind by the
 * user's own /exit (code 0, no attention) is as calm as an idle pane: it must
 * not outrank a sibling that works, waits or finished a turn — the session
 * would read "Shell" and its "concluiu" would never be told. A crash keeps
 * the fallback's own rank. */
function sessionRank(view: PaneStatusView): number {
  return view.tone === "fallback" && !view.attention
    ? TONE_PRIORITY.idle
    : TONE_PRIORITY[view.tone];
}

/**
 * The session-level status: the most urgent pane speaks for the session, and
 * its time is the longest any pane has been in that tone (a pane blocked for
 * ten minutes is the story, not the one that got blocked a second ago).
 */
export function describeSessionStatus(
  paneIds: string[],
  paneRuntime: Record<string, PaneStatusRuntime | undefined>,
  options: { spawned?: boolean } = {},
): SessionStatusView {
  if (options.spawned === false) {
    const tone: PaneStatusTone = "dormant";
    return {
      tone,
      label: TONE_LABEL[tone],
      detail: describeDetail(tone, undefined),
      attention: false,
      counts: { dormant: paneIds.length },
      paneCount: paneIds.length,
      summary: "",
    };
  }

  const counts: Partial<Record<PaneStatusTone, number>> = {};
  let winner: PaneStatusView | null = null;
  let winnerRank = 0;
  let winnerRuntime: PaneStatusRuntime | undefined;

  for (const paneId of paneIds) {
    const runtime = paneRuntime[paneId];
    const view = describePaneStatus(runtime);
    const rank = sessionRank(view);
    counts[view.tone] = (counts[view.tone] ?? 0) + 1;
    if (
      !winner ||
      rank > winnerRank ||
      (view.tone === winner.tone &&
        view.since !== undefined &&
        (winner.since === undefined || view.since < winner.since))
    ) {
      winner = view;
      winnerRank = rank;
      winnerRuntime = runtime;
    }
  }

  const base = winner ?? describePaneStatus(winnerRuntime);
  return {
    ...base,
    counts,
    paneCount: paneIds.length,
    summary: paneIds.length > 1 ? summarizeToneCounts(counts) : "",
  };
}
