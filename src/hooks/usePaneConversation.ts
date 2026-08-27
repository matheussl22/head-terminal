import { useEffect } from "react";

import {
  fetchResumableSessions,
  isResumableAgent,
} from "../core/agent-sessions-bridge";
import { resolvePaneConversationView } from "../core/conversation-display";
import { useSessionStore } from "../core/session-manager";

/** Panes that share a cwd would otherwise each scan the same transcripts on
 * startup. One lookup in flight per (cwd, agent, account) is enough — the
 * result lands in the store and every pane reads it from there. */
const inFlight = new Map<string, Promise<Array<{ id: string; title: string }>>>();

function lookupTitles(
  cwd: string,
  agentProfileId: string,
  claudeAccountId?: string,
): Promise<Array<{ id: string; title: string }>> {
  const key = `${agentProfileId}\u0000${claudeAccountId ?? ""}\u0000${cwd}`;
  const pending = inFlight.get(key);
  if (pending) {
    return pending;
  }

  const request = fetchResumableSessions(cwd, agentProfileId, claudeAccountId)
    .catch(() => [])
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

export interface PaneConversation {
  /** CLI session id this pane's conversation landed on, once it is known. */
  cliSessionId?: string;
  /** Name to show in the UI: the user's name when there is one, otherwise the
   * title derived from the transcript. Null while neither is known yet. */
  name: string | null;
  /** Whether `name` was typed by the user rather than read off the transcript. */
  isCustom: boolean;
  /** False for agents with no resumable conversations (shell, antigravity). */
  supported: boolean;
}

/**
 * Resolves which agent conversation a pane is currently on, and what to call
 * it. The pane's anchor (see pane-resume-anchor.ts) is the source of truth for
 * *which* conversation; the name is the user's label when set, otherwise the
 * transcript title, fetched on demand and cached in the store so a restart or
 * a session switch doesn't re-read the transcripts for a name we already have.
 */
export function usePaneConversation(options: {
  paneId: string;
  cwd: string;
  agentProfileId: string;
  claudeAccountId?: string;
}): PaneConversation {
  const { paneId, cwd, agentProfileId, claudeAccountId } = options;
  const supported = isResumableAgent(agentProfileId);

  const cliSessionId = useSessionStore(
    (state) => state.paneResumeAnchors[paneId],
  );
  const label = useSessionStore((state) =>
    cliSessionId ? state.conversationLabels[cliSessionId] : undefined,
  );
  const pendingLabel = useSessionStore(
    (state) => state.pendingConversationLabels[paneId],
  );
  const title = useSessionStore((state) =>
    cliSessionId ? state.conversationTitles[cliSessionId] : undefined,
  );
  const noteConversationTitles = useSessionStore(
    (state) => state.noteConversationTitles,
  );

  const needsTitle = supported && Boolean(cliSessionId) && title === undefined;

  useEffect(() => {
    if (!needsTitle) {
      return;
    }

    let cancelled = false;
    void lookupTitles(cwd, agentProfileId, claudeAccountId).then((entries) => {
      if (!cancelled && entries.length > 0) {
        noteConversationTitles(entries);
      }
    });

    return () => {
      cancelled = true;
    };
    // A conversation whose transcript is gone stays title-less: `needsTitle`
    // never flips back, so this doesn't retry in a loop.
  }, [needsTitle, cwd, agentProfileId, claudeAccountId, noteConversationTitles]);

  const custom = cliSessionId ? label : pendingLabel;
  const view = resolvePaneConversationView({
    cliSessionId,
    title,
    customLabel: custom,
  });

  return {
    cliSessionId,
    name: view.name,
    isCustom: view.isCustom,
    supported,
  };
}
