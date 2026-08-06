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

describe("agent profiles resume flag", () => {
  const SESSION_ID = "c8654eb2-0d87-42c0-a670-c5037d25b1e0";

  it("resumes claude, codex and cursor by session id", () => {
    const profiles = buildAgentProfiles({ resumeSessionId: SESSION_ID });
    expect(profiles.claude.args.join(" ")).toContain(`claude --resume ${SESSION_ID}`);
    expect(profiles.codex.args.join(" ")).toContain(`codex resume ${SESSION_ID}`);
    expect(profiles.cursor.args.join(" ")).toContain(
      `cursor agent --resume ${SESSION_ID}`,
    );
  });

  it("takes precedence over continueConversation", () => {
    const profiles = buildAgentProfiles({
      continueConversation: true,
      resumeSessionId: SESSION_ID,
    });
    expect(profiles.claude.args.join(" ")).not.toContain("--continue");
    expect(profiles.claude.args.join(" ")).toContain("--resume");
  });

  it("leaves antigravity and shell profiles untouched", () => {
    const profiles = buildAgentProfiles({ resumeSessionId: SESSION_ID });
    expect(profiles.antigravity.args.join(" ")).not.toContain(SESSION_ID);
    expect(profiles.shell.args.join(" ")).not.toContain(SESSION_ID);
  });

  it("ignores a session id that is not a plausible id (defense in depth)", () => {
    const profiles = buildAgentProfiles({
      resumeSessionId: "; rm -rf / #",
    });
    expect(profiles.claude.args.join(" ")).not.toContain("--resume");
    expect(profiles.claude.args.join(" ")).not.toContain("rm -rf");
  });
});
