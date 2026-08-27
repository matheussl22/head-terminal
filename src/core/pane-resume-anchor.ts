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
// After the file exists, the opening user message can land a few seconds
// later. Keep reading the title until it is real text, not "Sessão de …".
const TITLE_REFRESH_MS = 90_000;
const TITLE_REFRESH_DELAY_MS = 2_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function* retryDelays(): Generator<number> {
  yield* INITIAL_DELAYS_MS;
  while (true) {
    yield STEADY_DELAY_MS;
  }
}

function isPaneDead(paneId: string): boolean {
  return useSessionStore.getState().paneRuntime[paneId]?.status === "exited";
}

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

/** Timestamp fallbacks are not a conversation name. Mocks that omit
 * `fromTranscript` still count as named, so existing tests resolve as soon
 * as they anchor. */
export function hasTranscriptTitle(entry: {
  title: string;
  fromTranscript?: boolean;
}): boolean {
  if (entry.fromTranscript === false) return false;
  if (entry.fromTranscript === true) return true;
  return !/^Sessão de /u.test(entry.title);
}

/** Taken *before* the PTY starts so a jsonl the CLI creates while booting is
 * not snapshotted as "already there" and then ignored forever — that is what
 * left the header on "nova conversa" after the user had already typed. */
export async function snapshotExistingSessionIds(
  cwd: string,
  agentProfileId: string,
  claudeAccountId?: string,
): Promise<string[]> {
  if (!isResumableAgent(agentProfileId)) {
    return [];
  }
  const entries = await fetchResumableSessions(
    cwd,
    agentProfileId,
    claudeAccountId,
  ).catch(() => []);
  return entries.map((entry) => entry.id);
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
  /** Ids already on disk *before* this spawn. Prefer taking this before the
   * PTY starts; if omitted, a snapshot is taken at the beginning of the watch
   * (after spawn), which can miss a file the CLI created while booting. */
  existingSessionIds?: readonly string[];
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
    existingSessionIds,
    isDisposed,
  } = options;

  if (!isResumableAgent(agentProfileId)) {
    return;
  }

  // Small slack for clock/mtime granularity differences across filesystems.
  const threshold = spawnStartMs - 500;

  const preExisting = new Set<string>(existingSessionIds ?? []);
  if (startsNewConversation && existingSessionIds === undefined) {
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

  const publishTitles = (
    entries: Awaited<ReturnType<typeof fetchResumableSessions>>,
  ) => {
    if (entries.length > 0) {
      useSessionStore.getState().noteConversationTitles(entries);
    }
  };

  const refreshTitleUntilNamed = async (sessionId: string): Promise<void> => {
    const until = Date.now() + TITLE_REFRESH_MS;
    while (Date.now() < until) {
      await sleep(TITLE_REFRESH_DELAY_MS);
      if (isDisposed() || isPaneDead(paneId)) {
        return;
      }
      const latest = await fetchResumableSessions(
        cwd,
        agentProfileId,
        claudeAccountId,
      ).catch(() => []);
      if (isDisposed()) {
        return;
      }
      publishTitles(latest);
      const mine = latest.find((entry) => entry.id === sessionId);
      if (mine && hasTranscriptTitle(mine)) {
        return;
      }
    }
  };

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
    publishTitles(entries);

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
      if (!hasTranscriptTitle(fresh)) {
        await refreshTitleUntilNamed(fresh.id);
      }
      return;
    }
  }
}
