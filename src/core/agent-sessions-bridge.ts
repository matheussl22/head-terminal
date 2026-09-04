import { resolveClaudeConfigDir } from "./claude-accounts";

export interface ResumableSessionEntry {
  id: string;
  title: string;
  updatedAt: string;
  fromTranscript?: boolean;
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

  // Every Claude profile, the default included, keeps its own
  // CLAUDE_CONFIG_DIR (see claude-accounts.ts) — without this the lookup
  // would read the user's global ~/.claude, so picking a conversation either
  // shows another account's list or an id that --resume can't find.
  let claudeConfigDir: string | undefined;
  if (agentProfileId === "claude") {
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
