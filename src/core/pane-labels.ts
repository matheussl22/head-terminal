/** A few letters per agent, so ten terminals in a grid (or in a
 * notification) can be told apart: "cc3" is the third terminal, running
 * Claude Code. */
const AGENT_LABEL: Record<string, string> = {
  antigravity: "agy",
  cursor: "cx",
  claude: "cc",
  codex: "cdx",
  ollama: "olm",
  ornith: "orn",
  qwen27: "qw",
  shell: "sh",
};

/** "cc3": the agent's prefix and the pane's position in the session's
 * layout, counted from 1 — the name the pane header and its minimized card
 * show. */
export function paneShortLabel(agentProfileId: string, paneIndex: number): string {
  const prefix = AGENT_LABEL[agentProfileId] ?? agentProfileId.slice(0, 3);
  return `${prefix}${paneIndex + 1}`;
}
