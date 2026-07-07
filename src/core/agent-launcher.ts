import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { platform } from "@tauri-apps/plugin-os";

import {
  DEFAULT_AGENT_PROFILE_ID,
  getAgentProfile,
} from "../config/agents";
import { createEmptySession } from "./session-manager";
import { collectPaneIds } from "./session-layout";
import type { AgentSession } from "../types/session";

function getFallbackShell(): string {
  return platform() === "macos" ? "/bin/zsh" : "/usr/bin/zsh";
}

function basename(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || "Head";
}

async function resolveHomeDocumentsDir(): Promise<string> {
  try {
    const home = (await homeDir()).replace(/\/$/, "");
    return `${home}/Documentos`;
  } catch {
    return invoke<string>("get_default_cwd");
  }
}

export async function resolveDefaultCwd(): Promise<string> {
  return resolveHomeDocumentsDir();
}

export function createInitialSession(
  cwd: string,
  title?: string,
  agentProfileId = DEFAULT_AGENT_PROFILE_ID,
): AgentSession {
  const profile = getAgentProfile(agentProfileId);
  const sessionTitle = title ?? basename(cwd);

  return createEmptySession({
    id: crypto.randomUUID(),
    title: sessionTitle,
    cwd,
    agentProfileId: profile.id,
  });
}

const AGENT_SHORT_NAME: Record<string, string> = {
  cursor: "Cursor",
  claude: "Claude",
  codex: "OpenAI",
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
