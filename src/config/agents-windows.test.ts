import { describe, expect, it } from "vitest";

import {
  AGENT_FALLBACK_OSC,
  AGENT_RESUME_FALLBACK_OSC,
  WINDOWS_SHELL_COMMAND,
} from "./agents-shared";
import {
  WINDOWS_ORNITH_DEFAULT_GGUF,
  buildWindowsAgentProfiles,
  decodePowerShellCommand,
  encodePowerShellCommand,
  quoteWindowsGgufPath,
  sanitizeWindowsGgufPath,
} from "./agents-windows";

const AGENTS = ["claude", "cursor", "codex", "antigravity", "ollama", "ornith", "qwen27"];

function scriptOf(args: string[]): string {
  const index = args.indexOf("-EncodedCommand");
  expect(index).toBeGreaterThan(-1);
  return decodePowerShellCommand(args[index + 1]);
}

describe("Windows agent profiles", () => {
  it("runs every agent in a PowerShell that stays open after the agent exits", () => {
    const profiles = buildWindowsAgentProfiles({});
    for (const id of AGENTS) {
      const profile = profiles[id];
      expect(profile.command).toBe(WINDOWS_SHELL_COMMAND);
      expect(profile.args).toContain("-NoExit");
      // cursor-agent ships as a .ps1; the default policy would refuse it.
      expect(profile.args.slice(profile.args.indexOf("-ExecutionPolicy"), 2 + profile.args.indexOf("-ExecutionPolicy")))
        .toEqual(["-ExecutionPolicy", "Bypass"]);
      expect(scriptOf(profile.args)).toContain(
        `__ht_osc ${AGENT_FALLBACK_OSC} "agent-exited:$LASTEXITCODE"`,
      );
      expect(scriptOf(profile.args)).toContain("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8");
    }
  });

  it("round-trips the script through UTF-16LE base64, accents included", () => {
    const script = "Write-Host 'não encontrado — $x'";
    expect(decodePowerShellCommand(encodePowerShellCommand(script))).toBe(script);
  });

  it("calls the Windows CLIs by their PATH names and explains a missing one", () => {
    const profiles = buildWindowsAgentProfiles({});
    const claude = scriptOf(profiles.claude.args);
    expect(claude).toContain("if (Get-Command claude -ErrorAction SilentlyContinue) { claude }");
    expect(claude).toContain("winget install Anthropic.ClaudeCode");
    expect(scriptOf(profiles.cursor.args)).toContain("Get-Command cursor-agent");
    expect(scriptOf(profiles.cursor.args)).not.toContain("ht_unix_cmd");
    expect(scriptOf(profiles.codex.args)).toContain("winget install OpenAI.Codex");
    expect(scriptOf(profiles.antigravity.args)).toContain("Get-Command agy");
  });

  it("appends --continue for claude and cursor when restoring", () => {
    const profiles = buildWindowsAgentProfiles({ continueConversation: true });
    expect(scriptOf(profiles.claude.args)).toContain("{ claude --continue }");
    expect(scriptOf(profiles.cursor.args)).toContain("{ cursor-agent --continue }");
    expect(scriptOf(profiles.codex.args)).not.toContain("--continue");
  });

  it("resumes by id and starts fresh when the resume dies on startup", () => {
    const id = "33c584af-842d-4f34-914e-103047398416";
    const profiles = buildWindowsAgentProfiles({ resumeSessionId: id, continueConversation: true });
    const claude = scriptOf(profiles.claude.args);
    expect(claude).toContain(`claude --resume ${id}`);
    expect(claude).not.toContain("--continue");
    expect(claude).toContain(`__ht_osc ${AGENT_RESUME_FALLBACK_OSC} "resume-failed:$__ht_c"; claude }`);
    expect(claude).toContain("-lt 30");
    expect(scriptOf(profiles.codex.args)).toContain(`codex resume ${id}`);
    expect(scriptOf(profiles.cursor.args)).toContain(`cursor-agent --resume ${id}`);
  });

  it("ignores an implausible resume id", () => {
    const profiles = buildWindowsAgentProfiles({ resumeSessionId: "x; Remove-Item -Recurse" });
    expect(scriptOf(profiles.claude.args)).not.toContain("Remove-Item");
    expect(scriptOf(profiles.claude.args)).not.toContain("--resume");
  });

  it("runs the chosen ollama model, thinking off when asked", () => {
    const on = scriptOf(buildWindowsAgentProfiles({ ollamaModel: "qwen3:8b" }).ollama.args);
    expect(on).toContain("{ ollama run qwen3:8b }");
    const off = scriptOf(
      buildWindowsAgentProfiles({ ollamaModel: "qwen3:8b", ollamaThinkOff: true }).ollama.args,
    );
    expect(off).toContain("ollama run qwen3:8b --think=false");
    const none = scriptOf(buildWindowsAgentProfiles({}).ollama.args);
    expect(none).not.toContain("ollama run");
    expect(none).toContain("Nenhum modelo Ollama");
  });

  it("points llama-cli at a Windows GGUF and checks it exists first", () => {
    const ornith = scriptOf(buildWindowsAgentProfiles({}).ornith.args);
    expect(WINDOWS_ORNITH_DEFAULT_GGUF).toBe(
      "D:\\models\\ornith-1.5-35b\\Ornith-1.5-35B-Q4_K_M.gguf",
    );
    expect(ornith).toContain(`Test-Path -LiteralPath '${WINDOWS_ORNITH_DEFAULT_GGUF}'`);
    expect(ornith).toContain(`llama-cli -m '${WINDOWS_ORNITH_DEFAULT_GGUF}' -cnv -ngl 99 --cpu-moe`);
    expect(ornith).toContain("Get-Command llama-cli");

    const custom = scriptOf(
      buildWindowsAgentProfiles({ ggufPath: "E:/llm/it's.gguf" }).qwen27.args,
    );
    expect(custom).toContain("llama-cli -m 'E:\\llm\\it''s.gguf' -cnv --fit on");
  });

  it("gives a plain shell pane an interactive UTF-8 PowerShell", () => {
    const shell = buildWindowsAgentProfiles({}).shell;
    expect(shell.command).toBe(WINDOWS_SHELL_COMMAND);
    expect(shell.args).toContain("-NoExit");
    expect(scriptOf(shell.args)).toContain("[Console]::OutputEncoding");
    expect(scriptOf(shell.args)).not.toContain("__ht_osc 7770");
  });
});

describe("sanitizeWindowsGgufPath", () => {
  it("keeps a drive path and normalises the separator", () => {
    expect(sanitizeWindowsGgufPath("D:\\models\\a.gguf")).toBe("D:\\models\\a.gguf");
    expect(sanitizeWindowsGgufPath("d:/models/a.GGUF")).toBe("d:\\models\\a.GGUF");
  });

  it("translates a WSL-era mount path", () => {
    expect(sanitizeWindowsGgufPath("/mnt/d/models/a.gguf")).toBe("D:\\models\\a.gguf");
    expect(sanitizeWindowsGgufPath("/home/m/a.gguf")).toBeUndefined();
  });

  it("accepts a profile-relative path and quotes it through $env:USERPROFILE", () => {
    expect(sanitizeWindowsGgufPath("~/models/a.gguf")).toBe("~\\models\\a.gguf");
    expect(quoteWindowsGgufPath("~\\models\\a.gguf")).toBe('"$env:USERPROFILE\\models\\a.gguf"');
    expect(quoteWindowsGgufPath("D:\\it's.gguf")).toBe("'D:\\it''s.gguf'");
  });

  it("rejects anything that is not an absolute .gguf", () => {
    expect(sanitizeWindowsGgufPath("models\\a.gguf")).toBeUndefined();
    expect(sanitizeWindowsGgufPath("D:\\models\\a.bin")).toBeUndefined();
    expect(sanitizeWindowsGgufPath("D:\\models\\a.gguf\nrm")).toBeUndefined();
    expect(sanitizeWindowsGgufPath("")).toBeUndefined();
  });
});
