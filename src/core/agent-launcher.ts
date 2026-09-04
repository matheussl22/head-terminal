import {
  DEFAULT_AGENT_PROFILE_ID,
  getAgentProfile,
} from "../config/agents";
import { WINDOWS_SHELL_COMMAND } from "../config/agents-shared";
import { createEmptySession } from "./session-manager";
import { collectPaneIds } from "./session-layout";
import { basenamePath } from "./path-utils";
import { isWindowsHost } from "./platform-info";
import type { AgentSession } from "../types/session";

/** PowerShell on Windows (resolved by the main process), a login zsh elsewhere. */
function getFallbackShell(): string {
  if (isWindowsHost()) {
    return WINDOWS_SHELL_COMMAND;
  }
  const platform = typeof navigator === "undefined"
    ? process.platform
    : navigator.platform;
  return /mac/i.test(platform) ? "/bin/zsh" : "/usr/bin/zsh";
}

async function resolveHomeDocumentsDir(): Promise<string> {
  return window.headTerminal.system.getDefaultCwd();
}

export async function resolveDefaultCwd(): Promise<string> {
  return resolveHomeDocumentsDir();
}

export function createInitialSession(
  cwd: string,
  title?: string,
  agentProfileId = DEFAULT_AGENT_PROFILE_ID,
  extras: {
    claudeAccountId?: string;
    ollamaModel?: string;
    ollamaThinkOff?: boolean;
    ggufPath?: string;
  } = {},
): AgentSession {
  const profile = getAgentProfile(agentProfileId);
  const sessionTitle = title ?? basenamePath(cwd, "Head");

  return createEmptySession({
    id: crypto.randomUUID(),
    title: sessionTitle,
    cwd,
    agentProfileId: profile.id,
    claudeAccountId: extras.claudeAccountId,
    ollamaModel: extras.ollamaModel,
    ollamaThinkOff: extras.ollamaThinkOff,
    ggufPath: extras.ggufPath,
  });
}

const AGENT_SHORT_NAME: Record<string, string> = {
  antigravity: "Antigravity",
  cursor: "Cursor",
  claude: "Claude",
  codex: "OpenAI",
  ollama: "Ollama",
  ornith: "Ornith",
  qwen27: "Qwen",
  shell: "Shell",
};

// "Claude 1", "Claude 2", "OpenAI 1"... — conta só sessões do mesmo agent
// pra não pular número quando há sessões de outros agents já criadas.
export function nextAgentSessionTitle(
  agentProfileId: string,
  existingSessions: AgentSession[],
): string {
  const name = AGENT_SHORT_NAME[agentProfileId] ?? agentProfileId;
  const count = existingSessions.filter(
    (session) => session.agentProfileId === agentProfileId,
  ).length;
  return `${name} ${count + 1}`;
}

export function getShellPath(): string {
  return getFallbackShell();
}

export function getSessionPaneCount(session: AgentSession): number {
  return collectPaneIds(session.layout).length;
}
