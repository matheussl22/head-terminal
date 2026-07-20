import { describe, expect, it } from "vitest";

import { nextAgentSessionTitle } from "./agent-launcher";
import type { AgentSession } from "../types/session";

function fakeSession(agentProfileId: string): AgentSession {
  return { agentProfileId } as AgentSession;
}

describe("nextAgentSessionTitle", () => {
  it("começa em 1 quando não há sessões do agent", () => {
    expect(nextAgentSessionTitle("claude", [])).toBe("Claude 1");
  });

  it("incrementa só contando sessões do mesmo agent", () => {
    const sessions = [
      fakeSession("claude"),
      fakeSession("cursor"),
      fakeSession("claude"),
    ];
    expect(nextAgentSessionTitle("claude", sessions)).toBe("Claude 3");
    expect(nextAgentSessionTitle("cursor", sessions)).toBe("Cursor 2");
  });

  it("usa nome curto por agent (codex -> OpenAI)", () => {
    expect(nextAgentSessionTitle("codex", [])).toBe("OpenAI 1");
  });
});
