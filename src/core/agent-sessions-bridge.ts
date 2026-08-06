import { resolveClaudeConfigDir } from "./claude-accounts";

export interface ResumableSessionEntry {
  id: string;
  title: string;
  updatedAt: string;
}

const RESUMABLE_AGENTS = new Set(["claude", "codex", "cursor"]);

export function isResumableAgent(agentProfileId: string): boolean {
  return RESUMABLE_AGENTS.has(agentProfileId);
}

export async function fetchResumableSessions(
  cwd: string,
  agentProfileId: string,
  claudeAccountId?: string,
): Promise<ResumableSessionEntry[]> {
  if (!isResumableAgent(agentProfileId)) {
    return [];
  }

  // Isolated Claude profiles keep their own CLAUDE_CONFIG_DIR (see
  // claude-accounts.ts) — without this the lookup always reads the default
  // account's transcripts, so picking a conversation for a work/company
  // profile either shows the wrong list or an id that --resume can't find.
  let claudeConfigDir: string | undefined;
  if (agentProfileId === "claude" && claudeAccountId) {
    try {
      claudeConfigDir = resolveClaudeConfigDir(claudeAccountId);
    } catch {
      return [];
    }
  }

  return window.headTerminal.sessions.listResumable(
    cwd,
    agentProfileId as "claude" | "codex" | "cursor",
    claudeConfigDir,
  );
}
