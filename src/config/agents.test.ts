import { describe, expect, it, vi } from "vitest";

vi.mock("../core/agent-launcher", () => ({
  getShellPath: () => "/usr/bin/zsh",
}));

import {
  AGENT_FALLBACK_OSC,
  buildAgentProfiles,
  getAgentProfile,
} from "./agents";

describe("agent profiles continue flag", () => {
  it("spawns fresh by default", () => {
    const profiles = buildAgentProfiles();
    expect(profiles.claude.args.join(" ")).not.toContain("--continue");
    expect(profiles.cursor.args.join(" ")).not.toContain("--continue");
  });

  it("appends --continue for claude and cursor when restoring", () => {
    const profiles = buildAgentProfiles({ continueConversation: true });
    expect(profiles.claude.args.join(" ")).toContain("claude --continue");
    expect(profiles.cursor.args.join(" ")).toContain(
      "cursor agent --continue",
    );
  });

  it("leaves antigravity, codex and shell profiles untouched when restoring", () => {
    const profiles = buildAgentProfiles({ continueConversation: true });
    expect(profiles.antigravity.args.join(" ")).toContain("agy");
    expect(profiles.antigravity.args.join(" ")).toContain(
      String(AGENT_FALLBACK_OSC),
    );
    expect(profiles.antigravity.args.join(" ")).not.toContain("--continue");
    expect(profiles.codex.args.join(" ")).not.toContain("--continue");
    expect(profiles.shell.args.join(" ")).not.toContain("--continue");
  });

  it("getAgentProfile threads the option through", () => {
    const profile = getAgentProfile("claude", { continueConversation: true });
    expect(profile.args.join(" ")).toContain("claude --continue");
  });
});
