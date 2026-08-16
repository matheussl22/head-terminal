import {
  fetchResumableSessions,
  isResumableAgent,
} from "./agent-sessions-bridge";
import { useSessionStore } from "./session-manager";

// The CLI writes its transcript when the conversation gets its first message,
// not when it starts: `claude` can sit at an empty prompt for minutes with no
// ~/.claude/projects/<cwd>/<id>.jsonl on disk at all. The first attempts stay
// staggered because a --continue often touches its transcript right away, and
// after that we keep a slow beat for as long as the pane is alive. Giving up
// a few seconds after spawn is what left live conversations stuck on
// "nova conversa", with no anchor to persist for the next app start either.
const INITIAL_DELAYS_MS = [1500, 3000, 6000];
const STEADY_DELAY_MS = 10_000;
// A --resume either forks its transcript while the CLI boots or never will,
// so that watch is bounded — unlike the open-ended poll a fresh pane needs.
const RESUME_FORK_WATCH_MS = 90_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function* retryDelays(): Generator<number> {
  yield* INITIAL_DELAYS_MS;
  while (true) {
    yield STEADY_DELAY_MS;
  }
}

/** A pane whose process is gone will never write a transcript, so polling for
 * one is pure waste. Anything else — running, starting, idling at an empty
 * prompt — is still a conversation waiting to happen. */
function isPaneDead(paneId: string): boolean {
  return useSessionStore.getState().paneRuntime[paneId]?.status === "exited";
}

/** Ids already spoken for by another pane. Two panes sharing a cwd poll the
 * same list, and without this the second one would latch onto the first one's
 * conversation — same name in both headers, and one --resume stealing the
 * other's transcript on the next app start. */
function anchoredElsewhere(paneId: string): Set<string> {
  const anchors = useSessionStore.getState().paneResumeAnchors;
  const taken = new Set<string>();
  for (const [otherPaneId, sessionId] of Object.entries(anchors)) {
    if (otherPaneId !== paneId) {
      taken.add(sessionId);
    }
  }
  return taken;
}

export interface AnchorPaneResumeSessionOptions {
  paneId: string;
  cwd: string;
  agentProfileId: string;
  claudeAccountId?: string;
  /** Timestamp right before the pty spawned — only a transcript touched at
   * or after this point can belong to this spawn. */
  spawnStartMs: number;
  /** True when this spawn opens a brand new conversation (a bare `claude`),
   * false when it picks an existing one back up (`--continue`). */
  startsNewConversation: boolean;
  /** The id an explicit `--resume <id>` was given, if any. The CLI may replay
   * the whole conversation into a brand new transcript instead of appending
   * to that one; when it does, the pane has to follow the copy or it keeps
   * resuming the ancestor forever (one more copy per restart) while the live
   * conversation goes untracked. */
  resumedSessionId?: string;
  isDisposed: () => boolean;
}

/**
 * Best-effort: after a pane starts a conversation without an explicit
 * --resume id (fresh spawn or a plain --continue), find which CLI session
 * file it actually landed on and pin it as the pane's resume anchor. This
 * is what names the conversation in the pane header, and what lets a later
 * app restart bring back each pane's own conversation instead of every pane
 * racing onto the same --continue target.
 *
 * Never throws, never blocks a pane restart — same contract as
 * listResumableSessions on the main-process side.
 */
export async function anchorPaneResumeSession(
  options: AnchorPaneResumeSessionOptions,
): Promise<void> {
  const {
    paneId,
    cwd,
    agentProfileId,
    claudeAccountId,
    spawnStartMs,
    startsNewConversation,
    resumedSessionId,
    isDisposed,
  } = options;

  if (!isResumableAgent(agentProfileId)) {
    return;
  }

  // Small slack for clock/mtime granularity differences across filesystems.
  const threshold = spawnStartMs - 500;

  // A conversation that starts here cannot be one that already had a
  // transcript when the pane spawned. Splitting a pane used to land exactly
  // there: the sibling is mid-answer, so its transcript is the freshest thing
  // in the cwd and the new pane adopted its id — same name in both headers,
  // and one --resume stealing the other on the next app start. An mtime
  // threshold can't tell those apart; the id simply not existing yet can.
  // Taken before the CLI has finished booting, so it never hides the
  // transcript this spawn is about to create.
  const preExisting = new Set<string>();
  if (startsNewConversation) {
    const before = await fetchResumableSessions(
      cwd,
      agentProfileId,
      claudeAccountId,
    ).catch(() => []);
    for (const entry of before) {
      preExisting.add(entry.id);
    }
  }

  const watchUntilMs = resumedSessionId
    ? Date.now() + RESUME_FORK_WATCH_MS
    : null;

  for (const delay of retryDelays()) {
    await sleep(delay);
    if (isDisposed() || isPaneDead(paneId)) {
      return;
    }
    if (watchUntilMs !== null && Date.now() > watchUntilMs) {
      // No copy showed up: the CLI is appending to the very transcript the
      // pane asked for, which is where its anchor already points.
      return;
    }

    const entries = await fetchResumableSessions(
      cwd,
      agentProfileId,
      claudeAccountId,
    ).catch(() => []);
    if (isDisposed()) {
      return;
    }
    // The pane header names the conversation from this same list, so hand the
    // titles over instead of making it read the transcripts again.
    if (entries.length > 0) {
      useSessionStore.getState().noteConversationTitles(entries);
    }

    // As long as the resumed id is still listed, it is still this
    // conversation's live transcript. Dropping off the list is what a fork
    // looks like from here: the newer copy supersedes it (collapseForkCopies
    // in electron/services/agent-sessions-service.ts), and only then does
    // adopting a fresh id mean following our own conversation rather than
    // stealing a sibling pane's brand new one.
    if (resumedSessionId && entries.some((entry) => entry.id === resumedSessionId)) {
      continue;
    }

    const taken = anchoredElsewhere(paneId);
    const fresh = entries.find(
      (entry) =>
        Date.parse(entry.updatedAt) >= threshold
        && !taken.has(entry.id)
        && !preExisting.has(entry.id),
    );
    if (fresh) {
      useSessionStore.getState().notePaneResumeAnchor(paneId, fresh.id);
      return;
    }
  }
}
