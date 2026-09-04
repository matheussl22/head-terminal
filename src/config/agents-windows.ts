import { legacyPosixToWindowsPath } from "../core/path-utils";
import {
  AGENT_FALLBACK_OSC,
  AGENT_PROFILE_LABELS,
  AGENT_RESUME_FALLBACK_OSC,
  GGUF_PATH_MAX,
  ORNITH_DEFAULT_GGUF,
  ORNITH_FLAGS,
  ORNITH_HF_FILE,
  ORNITH_HF_REPO,
  QWEN27_DEFAULT_GGUF,
  QWEN27_FLAGS,
  QWEN27_HF_FILE,
  RESUME_FAILURE_WINDOW_SECONDS,
  WINDOWS_SHELL_COMMAND,
  sanitizeClaudeConfigDir,
  sanitizeOllamaModel,
  sanitizeResumeSessionId,
  type AgentProfile,
  type AgentProfileOptions,
} from "./agents-shared";

/**
 * Agent profiles for a native Windows pane: PowerShell hosting the Windows
 * builds of the agent CLIs (`claude.exe`, `codex.exe`, `cursor-agent.ps1`).
 * Same contract as the zsh profiles — run the agent, announce its exit with
 * the private OSC, leave the user on an interactive shell — spelled for
 * PowerShell. Everything here is Windows PowerShell 5.1-compatible on
 * purpose: `pwsh` is preferred when installed but never required.
 */

export const WINDOWS_ORNITH_DEFAULT_GGUF = legacyPosixToWindowsPath(ORNITH_DEFAULT_GGUF) as string;
export const WINDOWS_QWEN27_DEFAULT_GGUF = legacyPosixToWindowsPath(QWEN27_DEFAULT_GGUF) as string;

/**
 * `-EncodedCommand` takes the script as base64 of its UTF-16LE bytes. It is
 * the only way to hand PowerShell an arbitrary script from a command line
 * without fighting two layers of quoting (node-pty's argv join, then
 * PowerShell's own parser).
 */
export function encodePowerShellCommand(script: string): string {
  let binary = "";
  for (let index = 0; index < script.length; index += 1) {
    const code = script.charCodeAt(index);
    binary += String.fromCharCode(code & 0xff, code >> 8);
  }
  return btoa(binary);
}

/** Inverse of `encodePowerShellCommand`, for tests and diagnostics. */
export function decodePowerShellCommand(encoded: string): string {
  const binary = atob(encoded);
  let script = "";
  for (let index = 0; index + 1 < binary.length; index += 2) {
    script += String.fromCharCode(
      binary.charCodeAt(index) | (binary.charCodeAt(index + 1) << 8),
    );
  }
  return script;
}

/** PowerShell single-quoted literal: the only escape is a doubled quote. */
export function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// The agents write UTF-8; a 5.1 console defaults to the OEM code page and
// would show every accented character as garbage. `__ht_osc` is the private
// sentinel the pane listens for, `__ht_missing` the friendly "not installed"
// message that lands the pane on the shell like an agent exit would.
const PRELUDE = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
  "$OutputEncoding = [System.Text.Encoding]::UTF8",
  'function __ht_osc([int]$Code, [string]$Payload) { [Console]::Write("$([char]27)]$Code;$Payload$([char]7)") }',
  'function __ht_missing([string]$Name, [string]$Hint) { Write-Host "[head-terminal] $Name não encontrado no Windows. $Hint" -ForegroundColor Yellow; $global:LASTEXITCODE = 127 }',
].join("; ");

/** `-NoExit` is the PowerShell spelling of `exec zsh -l`: the script ends and
 * the same session stays open, interactive, in the pane. */
function withShellFallback(agentCmd: string): string[] {
  const script =
    `${PRELUDE}; ${agentCmd}; __ht_osc ${AGENT_FALLBACK_OSC} "agent-exited:$LASTEXITCODE"`;
  return [
    "-NoLogo",
    "-NoExit",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodePowerShellCommand(script),
  ];
}

/** Runs `run` only when `name` resolves on this machine; otherwise says why. */
function whenInstalled(name: string, run: string, hint: string): string {
  return (
    `if (Get-Command ${name} -ErrorAction SilentlyContinue) { ${run} } `
    + `else { __ht_missing ${psQuote(name)} ${psQuote(hint)} }`
  );
}

/** Same rule as the zsh builder: a resume that dies within the window starts
 * a fresh conversation and says so; a long-lived one that exits is a real end. */
function withResumeFallback(resumeCmd: string, freshCmd: string): string {
  return (
    `$__ht_t = [System.Diagnostics.Stopwatch]::StartNew(); ${resumeCmd}; $__ht_c = $LASTEXITCODE; `
    + `if ($__ht_c -ne 0 -and $__ht_t.Elapsed.TotalSeconds -lt ${RESUME_FAILURE_WINDOW_SECONDS}) { `
    + `__ht_osc ${AGENT_RESUME_FALLBACK_OSC} "resume-failed:$__ht_c"; ${freshCmd} }`
  );
}

const CLAUDE_HINT = "Instale com: winget install Anthropic.ClaudeCode";
const CODEX_HINT = "Instale com: winget install OpenAI.Codex";
const CURSOR_HINT = "Instale o Cursor Agent para Windows (cursor.com/install).";
const AGY_HINT = "Instale o Antigravity para Windows.";
const OLLAMA_HINT = "Instale em ollama.com/download.";
const LLAMA_HINT = "Instale o llama.cpp e crie a sessao de novo.";

function claudeArgs(
  continueConversation: boolean,
  resumeSessionId?: string,
  claudeConfigDir?: string,
): string[] {
  const id = sanitizeResumeSessionId(resumeSessionId);
  const command = id
    ? withResumeFallback(`claude --resume ${id}`, "claude")
    : continueConversation
      ? "claude --continue"
      : "claude";
  // Set in the script — i.e. after `$PROFILE` — and left set, so a `claude`
  // typed on the fallback shell later still lands on the pane's account.
  const configDir = sanitizeClaudeConfigDir(claudeConfigDir);
  const pinAccount = configDir ? `$env:CLAUDE_CONFIG_DIR = ${psQuote(configDir)}; ` : "";
  return withShellFallback(
    `${pinAccount}${whenInstalled("claude", command, CLAUDE_HINT)}`,
  );
}

function cursorArgs(continueConversation: boolean, resumeSessionId?: string): string[] {
  const id = sanitizeResumeSessionId(resumeSessionId);
  const command = id
    ? withResumeFallback(`cursor-agent --resume ${id}`, "cursor-agent")
    : continueConversation
      ? "cursor-agent --continue"
      : "cursor-agent";
  return withShellFallback(whenInstalled("cursor-agent", command, CURSOR_HINT));
}

function codexArgs(resumeSessionId?: string): string[] {
  const id = sanitizeResumeSessionId(resumeSessionId);
  const command = id ? withResumeFallback(`codex resume ${id}`, "codex") : "codex";
  return withShellFallback(whenInstalled("codex", command, CODEX_HINT));
}

function antigravityArgs(): string[] {
  return withShellFallback(whenInstalled("agy", "agy", AGY_HINT));
}

function ollamaArgs(model?: string, thinkOff = false): string[] {
  const name = sanitizeOllamaModel(model);
  if (!name) {
    return withShellFallback(
      'Write-Host "Nenhum modelo Ollama valido selecionado. Rode ""ollama list"" e crie a sessao de novo." -ForegroundColor Yellow; $global:LASTEXITCODE = 1',
    );
  }
  const thinkFlag = thinkOff ? " --think=false" : "";
  return withShellFallback(whenInstalled("ollama", `ollama run ${name}${thinkFlag}`, OLLAMA_HINT));
}

/**
 * `D:\models\x.gguf`, `D:/models/x.gguf`, `~\models\x.gguf` or a WSL-era
 * `/mnt/d/models/x.gguf` (translated). Returned with backslashes; `~` is kept
 * and expanded by `quoteGgufPath` at script time.
 */
export function sanitizeWindowsGgufPath(path?: string): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed || trimmed.length > GGUF_PATH_MAX || /[\0\n\r]/.test(trimmed)) {
    return undefined;
  }
  const candidate = trimmed.startsWith("/")
    ? legacyPosixToWindowsPath(trimmed)
    : trimmed.replaceAll("/", "\\");
  if (!candidate || !/\.gguf$/i.test(candidate)) {
    return undefined;
  }
  if (/^[A-Za-z]:\\.+/.test(candidate) || /^~\\.+/.test(candidate)) {
    return candidate;
  }
  return undefined;
}

/** Quote a GGUF path for PowerShell. `~\` becomes the user's profile dir. */
export function quoteWindowsGgufPath(path: string): string {
  if (path.startsWith("~\\")) {
    const rest = path.slice(2).replace(/["$`]/g, "`$&");
    return `"$env:USERPROFILE\\${rest}"`;
  }
  return psQuote(path);
}

function llamaArgs(
  ggufPath: string | undefined,
  fallbackPath: string,
  label: string,
  flags: readonly string[],
  missingHint: string,
): string[] {
  const path = sanitizeWindowsGgufPath(ggufPath) ?? sanitizeWindowsGgufPath(fallbackPath);
  if (!path) {
    return withShellFallback(
      `Write-Host "Nenhum arquivo GGUF valido para ${label}. Escolha o modelo nesta maquina e crie a sessao de novo." -ForegroundColor Yellow; $global:LASTEXITCODE = 1`,
    );
  }
  const quoted = quoteWindowsGgufPath(path);
  const run = ["llama-cli", "-m", quoted, ...flags].join(" ");
  const body =
    `if (-not (Test-Path -LiteralPath ${quoted})) { `
    + `Write-Host "Modelo ${label} nao encontrado em ${quoted.replaceAll('"', '""')}" -ForegroundColor Yellow; `
    + `Write-Host ${psQuote(missingHint)} -ForegroundColor Yellow; $global:LASTEXITCODE = 1 } `
    + `else { ${run} }`;
  return withShellFallback(whenInstalled("llama-cli", body, LLAMA_HINT));
}

function ornithArgs(ggufPath?: string): string[] {
  return llamaArgs(
    ggufPath,
    WINDOWS_ORNITH_DEFAULT_GGUF,
    "Ornith-1.5-35B",
    ORNITH_FLAGS,
    `Baixe o GGUF e aponte o arquivo na nova sessao: huggingface-cli download ${ORNITH_HF_REPO} ${ORNITH_HF_FILE}`,
  );
}

function qwen27Args(ggufPath?: string): string[] {
  return llamaArgs(
    ggufPath,
    WINDOWS_QWEN27_DEFAULT_GGUF,
    "Qwen 27B Uncensored",
    QWEN27_FLAGS,
    `Baixe o GGUF (${QWEN27_HF_FILE}) e aponte o arquivo na nova sessao.`,
  );
}

/** A plain shell pane: interactive PowerShell with UTF-8 I/O. */
function shellArgs(): string[] {
  return ["-NoLogo", "-NoExit", "-EncodedCommand", encodePowerShellCommand(PRELUDE)];
}

export function buildWindowsAgentProfiles(
  options: AgentProfileOptions,
): Record<string, AgentProfile> {
  const continueConversation = options.continueConversation ?? false;
  const { resumeSessionId } = options;
  const profile = (id: string, args: string[]): AgentProfile => ({
    id,
    label: AGENT_PROFILE_LABELS[id] ?? id,
    command: WINDOWS_SHELL_COMMAND,
    args,
  });

  return {
    antigravity: profile("antigravity", antigravityArgs()),
    cursor: profile("cursor", cursorArgs(continueConversation, resumeSessionId)),
    claude: profile(
      "claude",
      claudeArgs(continueConversation, resumeSessionId, options.claudeConfigDir),
    ),
    codex: profile("codex", codexArgs(resumeSessionId)),
    ollama: profile("ollama", ollamaArgs(options.ollamaModel, options.ollamaThinkOff)),
    ornith: profile("ornith", ornithArgs(options.ggufPath)),
    qwen27: profile("qwen27", qwen27Args(options.ggufPath)),
    shell: profile("shell", shellArgs()),
  };
}
