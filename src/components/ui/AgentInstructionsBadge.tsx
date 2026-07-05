import { sendAgentCommand } from "../../actions/sendAgentCommand";
import {
  agentInstructionLabel,
  formatAgentInstructionMention,
} from "../../core/agent-instructions";

interface AgentInstructionsBadgeProps {
  filename: string;
  repoRoot: string;
}

export function AgentInstructionsBadge({
  filename,
  repoRoot,
}: AgentInstructionsBadgeProps) {
  const label = agentInstructionLabel(filename);
  const mention = formatAgentInstructionMention(filename);

  return (
    <button
      type="button"
      className="agent-instructions-badge"
      title={`${label} encontrado em ${repoRoot}. Clique para referenciar no agent (${mention}).`}
      onClick={() => sendAgentCommand(mention)}
    >
      <span className="agent-instructions-badge__icon" aria-hidden>
        ◈
      </span>
      {label}
    </button>
  );
}
