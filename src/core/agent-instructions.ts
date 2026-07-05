import { invoke } from "@tauri-apps/api/core";

/** Per-repo agent instruction files, highest priority first. */
export const AGENT_INSTRUCTION_FILES = [
  "AGENTS.md",
  "AGENT.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
  "CURSOR.md",
] as const;

export type AgentInstructionFile = (typeof AGENT_INSTRUCTION_FILES)[number];

export function formatAgentInstructionMention(filename: string): string {
  return `@${filename}`;
}

export function agentInstructionLabel(filename: string): string {
  if (filename === "AGENTS.md") {
    return "AGENTS.md";
  }
  if (filename === "GEMINI.md") {
    return "GEMINI.md";
  }
  if (filename === "CLAUDE.md") {
    return "CLAUDE.md";
  }
  if (filename === ".cursorrules") {
    return ".cursorrules";
  }
  return filename;
}

export async function findAgentInstructionFile(
  repoRoot: string,
): Promise<string | null> {
  const trimmed = repoRoot.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return await invoke<string | null>("find_agent_instruction", {
      repoRoot: trimmed,
    });
  } catch {
    return null;
  }
}
