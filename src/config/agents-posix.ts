import { HT_UNIX_CMD_FN, UNIX_USER_BIN_PATH_EXPORT } from "../core/unix-cli-probe";
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
  sanitizeOllamaModel,
  sanitizeResumeSessionId,
  type AgentProfile,
  type AgentProfileOptions,
} from "./agents-shared";

/**
 * Agent profiles for a login zsh — Linux and macOS. Every profile is a
 * `zsh -l -c <script>` whose script runs the agent, announces its exit with
 * a private OSC and then hands the pane to an interactive shell.
 */

/**
 * `--resume <id>` dies immediately when the CLI won't take the id — the
 * transcript was deleted, belongs to another account, or the CLI rejects it
 * for reasons of its own ("No conversation found with session ID"). Without
 * this the pane lands on the bare shell fallback and the user has to notice
 * and restart it by hand; instead it starts a fresh agent and says so.
 *
 * A resumed session that ran for a while and then exited non-zero is a real
 * session ending, so it keeps falling through to the shell as before.
 */
function withResumeFallback(resumeCmd: string, freshCmd: string): string {
  return (
    `__ht_resume_start=$SECONDS; ${resumeCmd}; __ht_resume_code=$?; `
    + `if [ $__ht_resume_code -ne 0 ] `
    + `&& [ $((SECONDS - __ht_resume_start)) -lt ${RESUME_FAILURE_WINDOW_SECONDS} ]; then `
    + `printf "\\033]${AGENT_RESUME_FALLBACK_OSC};resume-failed:%s\\007" $__ht_resume_code; `
    + `${freshCmd}; fi`
  );
}

function withShellFallback(agentCmd: string): string[] {
  return [
    "-l",
    "-c",
    `${UNIX_USER_BIN_PATH_EXPORT}; ${agentCmd}; printf "\\033]${AGENT_FALLBACK_OSC};agent-exited:%s\\007" $?; exec zsh -l`,
  ];
}

/**
 * The official installer puts the CLI on the PATH as `cursor-agent`, while
 * older setups reach it as the `agent` subcommand of `cursor`. Neither name is
 * safe to hardcode, so the pane picks whichever the shell can actually find.
 *
 * `ht_unix_cmd` skips Windows launchers (`.cmd`, `.ps1`, anything on a mounted
 * drive) that a foreign PATH may leak in, so a missing Linux CLI fails cleanly
 * instead of crashing the agent with `@echo: not found`.
 */
const CURSOR_SHIM =
  HT_UNIX_CMD_FN
  + "ht_cursor() { "
  + "if ht_unix_cmd cursor-agent; then cursor-agent \"$@\"; "
  + "elif ht_unix_cmd cursor; then cursor agent \"$@\"; "
  + "else printf '%s\\n' "
  + "'[head-terminal] cursor-agent não encontrado' >&2; return 127; fi; }; ";

function cursorWithFallbackArgs(
  continueConversation: boolean,
  resumeSessionId?: string,
): string[] {
  const id = sanitizeResumeSessionId(resumeSessionId);
  const command = id
    ? withResumeFallback(`ht_cursor --resume ${id}`, "ht_cursor")
    : continueConversation
      ? "ht_cursor --continue"
      : "ht_cursor";
  return withShellFallback(`${CURSOR_SHIM}${command}`);
}

function claudeWithFallbackArgs(
  continueConversation: boolean,
  resumeSessionId?: string,
): string[] {
  const id = sanitizeResumeSessionId(resumeSessionId);
  return withShellFallback(
    id
      ? withResumeFallback(`claude --resume ${id}`, "claude")
      : continueConversation
        ? "claude --continue"
        : "claude",
  );
}

function codexWithFallbackArgs(resumeSessionId?: string): string[] {
  // ponytail: codex CLI not installed locally, no confirmed --continue
  // equivalent — always spawns fresh until that's verified. --resume <id>
  // is confirmed (`codex resume <id>`), so that path is wired regardless.
  const id = sanitizeResumeSessionId(resumeSessionId);
  return withShellFallback(
    id ? withResumeFallback(`codex resume ${id}`, "codex") : "codex",
  );
}

function antigravityWithFallbackArgs(): string[] {
  return withShellFallback("agy");
}

function ollamaWithFallbackArgs(model?: string, thinkOff = false): string[] {
  const name = sanitizeOllamaModel(model);
  // No usable model means no command to run: say why and let the shell
  // fallback take the pane, instead of dropping the user into `ollama`'s
  // usage text with no explanation.
  const thinkFlag = thinkOff ? " --think=false" : "";
  return withShellFallback(
    name
      ? `ollama run ${name}${thinkFlag}`
      : `printf "Nenhum modelo Ollama valido selecionado. Rode \\"ollama list\\" e crie a sessao de novo.\\n" >&2; false`,
  );
}

/** Absolute POSIX, `~/…`, or `D:\…` path to a `.gguf`. Windows drive paths
 * become `/mnt/<drive>/…` so llama-cli inside a Linux pane can open the file.
 * Newlines are rejected; the rest is single-quoted into the login shell. */
export function sanitizeGgufPath(path?: string): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed || trimmed.length > GGUF_PATH_MAX) {
    return undefined;
  }
  if (/[\0\n\r]/.test(trimmed)) {
    return undefined;
  }
  const windows = /^([A-Za-z]):[\\/](.+\.gguf)$/i.exec(trimmed);
  if (windows) {
    return `/mnt/${windows[1].toLowerCase()}/${windows[2].replaceAll("\\", "/")}`;
  }
  if (!/^(?:~\/|\/).+\.gguf$/i.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote a GGUF path for a login-shell command. `~/` stays expandable. */
export function quoteGgufPath(path: string): string {
  if (path.startsWith("~/")) {
    return `"$HOME/${path.slice(2).replace(/["\\$`]/g, "\\$&")}"`;
  }
  return shellSingleQuote(path);
}

function llamaWithFallbackArgs(
  ggufPath: string | undefined,
  fallbackPath: string,
  label: string,
  flags: readonly string[],
  missingHint: string,
): string[] {
  const path = sanitizeGgufPath(ggufPath) ?? sanitizeGgufPath(fallbackPath);
  if (!path) {
    return withShellFallback(
      `printf "Nenhum arquivo GGUF valido para ${label}. Escolha o modelo nesta maquina e crie a sessao de novo.\\n" >&2; false`,
    );
  }
  const quoted = quoteGgufPath(path);
  const run = ["llama-cli", "-m", quoted, ...flags].join(" ");
  return withShellFallback(
    `if ! command -v llama-cli >/dev/null 2>&1; then ` +
      `printf "llama-cli nao encontrado. Instale o llama.cpp e crie a sessao de novo.\\n" >&2; false; ` +
      `elif [ ! -f ${quoted} ]; then ` +
      `printf "Modelo ${label} nao encontrado em %s\\n" ${quoted} >&2; ` +
      `${missingHint}` +
      `else ${run}; fi`,
  );
}

function ornithWithFallbackArgs(ggufPath?: string): string[] {
  return llamaWithFallbackArgs(
    ggufPath,
    ORNITH_DEFAULT_GGUF,
    "Ornith-1.5-35B",
    ORNITH_FLAGS,
    `printf "Baixe o GGUF e aponte o arquivo na nova sessao:\\n  huggingface-cli download ${ORNITH_HF_REPO} ${ORNITH_HF_FILE}\\n" >&2; false; `,
  );
}

function qwen27WithFallbackArgs(ggufPath?: string): string[] {
  return llamaWithFallbackArgs(
    ggufPath,
    QWEN27_DEFAULT_GGUF,
    "Qwen 27B Uncensored",
    QWEN27_FLAGS,
    `printf "Baixe o GGUF (${QWEN27_HF_FILE}) e aponte o arquivo na nova sessao.\\n" >&2; false; `,
  );
}

export function buildPosixAgentProfiles(
  options: AgentProfileOptions,
  shell: string,
): Record<string, AgentProfile> {
  const continueConversation = options.continueConversation ?? false;
  const { resumeSessionId } = options;
  const profile = (id: string, args: string[]): AgentProfile => ({
    id,
    label: AGENT_PROFILE_LABELS[id] ?? id,
    command: shell,
    args,
  });

  return {
    antigravity: profile("antigravity", antigravityWithFallbackArgs()),
    cursor: profile("cursor", cursorWithFallbackArgs(continueConversation, resumeSessionId)),
    claude: profile("claude", claudeWithFallbackArgs(continueConversation, resumeSessionId)),
    codex: profile("codex", codexWithFallbackArgs(resumeSessionId)),
    ollama: profile("ollama", ollamaWithFallbackArgs(options.ollamaModel, options.ollamaThinkOff)),
    ornith: profile("ornith", ornithWithFallbackArgs(options.ggufPath)),
    qwen27: profile("qwen27", qwen27WithFallbackArgs(options.ggufPath)),
    shell: profile("shell", ["-l"]),
  };
}
