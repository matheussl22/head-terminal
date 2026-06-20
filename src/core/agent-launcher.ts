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

export function createNamedSession(
  cwd: string,
  index: number,
): AgentSession {
  return createInitialSession(cwd, `Sessão ${index}`);
}

export function getShellPath(): string {
  return getFallbackShell();
}

export function getSessionPaneCount(session: AgentSession): number {
  return collectPaneIds(session.layout).length;
}
