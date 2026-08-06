import {
  fetchResumableSessions,
  isResumableAgent,
} from "./agent-sessions-bridge";
import { useSessionStore } from "./session-manager";

// How long we're willing to wait for the CLI to write its transcript file
// after a fresh spawn before giving up on anchoring this pane. Claude/Cursor
// create the file close to startup, but slow disks/first-run overhead can
// delay it — a few staggered attempts beat a single fixed guess.
const RETRY_DELAYS_MS = [1500, 3000, 6000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AnchorPaneResumeSessionOptions {
  paneId: string;
  cwd: string;
  agentProfileId: string;
  claudeAccountId?: string;
  /** Timestamp right before the pty spawned — only a transcript touched at
   * or after this point can belong to this spawn. */
  spawnStartMs: number;
  isDisposed: () => boolean;
}

/**
 * Best-effort: after a pane starts a conversation without an explicit
 * --resume id (fresh spawn or a plain --continue), find which CLI session
 * file it actually landed on and pin it as the pane's resume anchor. This
 * is what lets a later app restart bring back each pane's own conversation
 * instead of every pane racing onto the same --continue target.
 *
 * Never throws, never blocks a pane restart — same contract as
 * listResumableSessions on the main-process side.
 */
export async function anchorPaneResumeSession(
  options: AnchorPaneResumeSessionOptions,
): Promise<void> {
  const { paneId, cwd, agentProfileId, claudeAccountId, spawnStartMs, isDisposed } =
    options;

  if (!isResumableAgent(agentProfileId)) {
    return;
  }

  // Small slack for clock/mtime granularity differences across filesystems.
  const threshold = spawnStartMs - 500;

  for (const delay of RETRY_DELAYS_MS) {
    await sleep(delay);
    if (isDisposed()) {
      return;
    }

    const entries = await fetchResumableSessions(
      cwd,
      agentProfileId,
      claudeAccountId,
    ).catch(() => []);
    const fresh = entries.find((entry) => Date.parse(entry.updatedAt) >= threshold);
    if (fresh) {
      if (!isDisposed()) {
        useSessionStore.getState().notePaneResumeAnchor(paneId, fresh.id);
      }
      return;
    }
  }
}
