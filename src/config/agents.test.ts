import { describe, expect, it, vi } from "vitest";

vi.mock("../core/agent-launcher", () => ({
  getShellPath: () => "/usr/bin/zsh",
}));

import {
  AGENT_FALLBACK_OSC,
  buildAgentProfiles,
  getAgentProfile,
  quoteGgufPath,
} from "./agents";

describe("agent profiles continue flag", () => {
  it("spawns fresh by default", () => {
    const profiles = buildAgentProfiles();
    expect(profiles.claude.args.join(" ")).not.toContain("--continue");
    expect(profiles.cursor.args.join(" ")).not.toContain("--continue");
  });

  it("reaches a Unix-native cursor-agent and never a Windows .cmd", () => {
    // The official installer publishes `cursor-agent`; older setups expose the
    // same CLI as `cursor agent`. Hardcoding either opens the pane straight
    // into `command not found`. WSL interop also finds cursor-agent.cmd on
    // /mnt/c, which a Unix shell cannot execute.
    const script = buildAgentProfiles().cursor.args.join(" ");
    expect(script).toContain("ht_unix_cmd cursor-agent");
    expect(script).toContain('cursor-agent "$@"');
    expect(script).toContain('cursor agent "$@"');
    expect(script).not.toContain("cursor-agent.cmd");
    expect(script).toContain("/mnt/[a-z]/*");
    expect(script).toContain("$HOME/.local/bin");
  });

  it("appends --continue for claude and cursor when restoring", () => {
    const profiles = buildAgentProfiles({ continueConversation: true });
    expect(profiles.claude.args.join(" ")).toContain("claude --continue");
    // cursor is invoked through the shim that resolves its binary name.
    expect(profiles.cursor.args.join(" ")).toContain("ht_cursor --continue");
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
      `ht_cursor --resume ${SESSION_ID}`,
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

  it("starts a fresh agent when the resume dies on startup, and only then", () => {
    const claude = buildAgentProfiles({ resumeSessionId: SESSION_ID }).claude
      .args.join(" ");

    // Fresh fallback command, guarded by exit code and by how long the
    // resumed agent lived — a real session that ends non-zero after a while
    // still goes to the shell fallback instead of relaunching the agent.
    expect(claude).toContain("__ht_resume_code=$?");
    expect(claude).toContain("-lt 30");
    expect(claude).toMatch(/resume-failed:%s.*claude; fi/u);
  });

  it("keeps a plain spawn free of the resume fallback plumbing", () => {
    const profiles = buildAgentProfiles({ continueConversation: true });
    expect(profiles.claude.args.join(" ")).not.toContain("__ht_resume_code");
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

describe("ollama profile", () => {
  it("runs the chosen local model", () => {
    const profiles = buildAgentProfiles({
      ollamaModel: "qwen38-27b-uncensored:latest",
    });
    expect(profiles.ollama.args.join(" ")).toContain(
      "ollama run qwen38-27b-uncensored:latest",
    );
    expect(profiles.ollama.args.join(" ")).toContain(String(AGENT_FALLBACK_OSC));
  });

  it("accepts namespaced model names", () => {
    const profiles = buildAgentProfiles({ ollamaModel: "library/llama3.2:3b" });
    expect(profiles.ollama.args.join(" ")).toContain(
      "ollama run library/llama3.2:3b",
    );
  });

  it("explains itself instead of running anything without a model", () => {
    const args = buildAgentProfiles().ollama.args.join(" ");
    expect(args).not.toContain("ollama run");
    expect(args).toContain("Nenhum modelo Ollama");
  });

  it("rejects a model name carrying shell syntax", () => {
    const args = buildAgentProfiles({
      ollamaModel: "llama3; rm -rf / #",
    }).ollama.args.join(" ");
    expect(args).not.toContain("ollama run");
    expect(args).not.toContain("rm -rf");
  });

  it("leaves the other profiles untouched", () => {
    const profiles = buildAgentProfiles({ ollamaModel: "llama3.2" });
    expect(profiles.claude.args.join(" ")).not.toContain("ollama");
    expect(profiles.shell.args.join(" ")).not.toContain("ollama");
  });

  it("starts with thinking off when asked", () => {
    const args = buildAgentProfiles({
      ollamaModel: "qwen38-27b-uncensored:latest",
      ollamaThinkOff: true,
    }).ollama.args.join(" ");
    expect(args).toContain(
      "ollama run qwen38-27b-uncensored:latest --think=false",
    );
  });

  it("keeps thinking on by default", () => {
    const args = buildAgentProfiles({
      ollamaModel: "qwen38-27b-uncensored:latest",
    }).ollama.args.join(" ");
    expect(args).toContain("ollama run qwen38-27b-uncensored:latest");
    expect(args).not.toContain("--think=false");
  });
});

describe("ornith profile", () => {
  it("runs llama-cli in conversation mode with the MoE 3060 config", () => {
    const args = buildAgentProfiles().ornith.args.join(" ");
    expect(args).toContain("llama-cli -m");
    expect(args).toContain("Ornith-1.5-35B-Q4_K_M.gguf");
    expect(args).toContain("-cnv");
    expect(args).toContain("--cpu-moe");
    expect(args).toContain("-c 16384");
    expect(args).toContain("--reasoning on");
    expect(args).toContain(String(AGENT_FALLBACK_OSC));
  });

  it("explains a missing GGUF instead of launching llama-cli blindly", () => {
    const args = buildAgentProfiles().ornith.args.join(" ");
    expect(args).toContain("[ ! -f");
    expect(args).toContain("huggingface-cli download");
    expect(args).toContain("ornith-ai/Ornith-1.5-35B-A3B-GGUF");
  });

  it("uses the GGUF the user pointed at on this machine", () => {
    const custom = "/data/weights/custom ornith.gguf";
    const args = buildAgentProfiles({ ggufPath: custom }).ornith.args.join(" ");
    expect(args).toContain("'/data/weights/custom ornith.gguf'");
    expect(args).not.toContain("ornith-1.5-35b");
  });

  it("quotes a path that would otherwise break the login shell", () => {
    const sneaky = "/tmp/foo.gguf'; rm -rf / #.gguf";
    const args = buildAgentProfiles({ ggufPath: sneaky }).ornith.args.join(" ");
    expect(args).toContain("llama-cli -m");
    expect(args).toContain("'\\''");
    expect(args).toContain(quoteGgufPath(sneaky));
  });

  it("rejects a path that is not a GGUF and falls back to the conventional file", () => {
    const args = buildAgentProfiles({
      ggufPath: "/tmp/not-a-model.bin",
    }).ornith.args.join(" ");
    expect(args).toContain("Ornith-1.5-35B-Q4_K_M.gguf");
    expect(args).not.toContain("not-a-model.bin");
  });

  it("leaves the other profiles untouched", () => {
    const profiles = buildAgentProfiles();
    expect(profiles.ollama.args.join(" ")).not.toContain("llama-cli");
    expect(profiles.shell.args.join(" ")).not.toContain("Ornith");
  });
});

describe("qwen27 profile", () => {
  it("runs llama-cli with CUDA fit instead of ngl 99", () => {
    const args = buildAgentProfiles().qwen27.args.join(" ");
    expect(args).toContain("llama-cli -m");
    expect(args).toContain("Qwen3.8-27B-Uncensored-IQ4_XS.gguf");
    expect(args).toContain("-cnv");
    expect(args).toContain("--fit on");
    expect(args).toContain("--fit-target 128");
    expect(args).toContain("-c 4096");
    expect(args).toContain("--cache-type-k q4_0");
    expect(args).toContain("-t 6");
    expect(args).toContain("--load-mode mmap+mlock");
    expect(args).toContain("--reasoning off");
    expect(args).not.toContain("-ngl 99");
    expect(args).not.toContain("--cpu-moe");
    expect(args).toContain(String(AGENT_FALLBACK_OSC));
  });

  it("uses a machine-local GGUF when given one", () => {
    const custom = "/mnt/models/Qwen3.8-27B-Uncensored-IQ4_XS.gguf";
    const args = buildAgentProfiles({ ggufPath: custom }).qwen27.args.join(" ");
    expect(args).toContain(`'${custom}'`);
    expect(args).not.toContain("qwen38-27b-uncensored/");
  });
});
