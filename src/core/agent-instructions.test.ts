import { describe, expect, it } from "vitest";

import {
  AGENT_INSTRUCTION_FILES,
  agentInstructionLabel,
  formatAgentInstructionMention,
} from "./agent-instructions";

describe("agent-instructions", () => {
  it("lists instruction files in priority order", () => {
    expect(AGENT_INSTRUCTION_FILES[0]).toBe("AGENTS.md");
    expect(AGENT_INSTRUCTION_FILES).toContain("GEMINI.md");
    expect(AGENT_INSTRUCTION_FILES).toContain(".cursorrules");
  });

  it("formats @ mentions for agent input", () => {
    expect(formatAgentInstructionMention("AGENTS.md")).toBe("@AGENTS.md");
    expect(formatAgentInstructionMention(".cursorrules")).toBe("@.cursorrules");
  });

  it("humanizes known filenames", () => {
    expect(agentInstructionLabel("AGENTS.md")).toBe("AGENTS.md");
    expect(agentInstructionLabel(".cursorrules")).toBe(".cursorrules");
    expect(agentInstructionLabel("CUSTOM.md")).toBe("CUSTOM.md");
  });
});
