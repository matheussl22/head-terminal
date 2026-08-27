import { getShellPath } from "../core/agent-launcher";
import { HT_UNIX_CMD_FN, UNIX_USER_BIN_PATH_EXPORT } from "../core/unix-cli-probe";

export interface AgentProfile {
  id: string;
  label: string;
  command: string;
  args: string[];
}

// Private OSC emitted between the agent dying and the shell fallback taking
// over, so the UI can tell "agent crashed, shell active" apart from normal
// output. Payload: "agent-exited:<exit code>".
export const AGENT_FALLBACK_OSC = 7770;

// Private OSC emitted when a `--resume` never got off the ground and the
// pane started a fresh conversation instead. Payload:
// "resume-failed:<exit code>".
export const AGENT_RESUME_FALLBACK_OSC = 7771;

/** How long a resumed agent has to live before its failure counts as a real
 * session ending rather than a resume that never started. */
const RESUME_FAILURE_WINDOW_SECONDS = 30;

// Session ids picked from the resume dropdown are always claude/codex/cursor
// UUIDs (see electron/services/agent-sessions-service.ts) or codex's rollout
// id — this guards the shell interpolation below against anything else that
// might end up here, defense in depth rather than trusting the IPC boundary.
const RESUMABLE_SESSION_ID = /^[0-9a-f-]{8,64}$/i;

function sanitizeResumeSessionId(resumeSessionId?: string): string | undefined {
  return resumeSessionId && RESUMABLE_SESSION_ID.test(resumeSessionId)
    ? resumeSessionId
    : undefined;
}

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
 * WSL interop also finds the Windows `cursor-agent.cmd`; executing that as a
 * Unix script is what produced `@echo: not found` in the pane. `ht_unix_cmd`
 * skips those hits so a missing Linux CLI fails cleanly (and can be installed)
 * instead of crashing the agent.
 */
const CURSOR_SHIM =
  HT_UNIX_CMD_FN
  + "ht_cursor() { "
  + "if ht_unix_cmd cursor-agent; then cursor-agent \"$@\"; "
  + "elif ht_unix_cmd cursor; then cursor agent \"$@\"; "
  + "else printf '%s\\n' "
  + "'[head-terminal] cursor-agent Linux não encontrado "
  + "(o .cmd do Windows não roda no WSL)' >&2; return 127; fi; }; ";

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

// `ollama run <model>` — model names look like `namespace/name:tag`. The value
// reaches here from the create-session dialog, where the user can type it by
// hand, so it is validated before landing in a login shell rather than trusted.
const OLLAMA_MODEL =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*(:[A-Za-z0-9._-]+)?$/;

function sanitizeOllamaModel(model?: string): string | undefined {
  const trimmed = model?.trim();
  return trimmed && trimmed.length <= 128 && OLLAMA_MODEL.test(trimmed)
    ? trimmed
    : undefined;
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

/** llama.cpp flags on Ornith/Qwen were measured on this card. Other VRAM
 * sizes need their own ngl / cpu-moe / ctx — do not copy these blindly. */
export const LLAMA_HARDWARE_PROFILE = "RTX 3060 Ti 8 GB";

/** Conventional layout if the user followed the download hint. Override
 * per machine in the create-session dialog; the GGUF itself is never in git. */
export const ORNITH_DEFAULT_GGUF =
  "~/models/ornith-1.5-35b/Ornith-1.5-35B-Q4_K_M.gguf";
export const QWEN27_DEFAULT_GGUF =
  "~/models/qwen38-27b-uncensored/Qwen3.8-27B-Uncensored-IQ4_XS.gguf";

export const ORNITH_HF_REPO = "ornith-ai/Ornith-1.5-35B-A3B-GGUF";
export const ORNITH_HF_FILE = "Ornith-1.5-35B-Q4_K_M.gguf";
export const QWEN27_HF_FILE = "Qwen3.8-27B-Uncensored-IQ4_XS.gguf";

const GGUF_PATH_MAX = 4_096;

/** Absolute POSIX or `~/…` path to a `.gguf`. Newlines are rejected; the
 * rest is single-quoted into the login shell so spaces and quotes survive. */
export function sanitizeGgufPath(path?: string): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed || trimmed.length > GGUF_PATH_MAX) {
    return undefined;
  }
  if (/[\0\n\r]/.test(trimmed)) {
    return undefined;
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
  flags: string[],
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

// Tweet config assumed a 12GB 3060 with --n-cpu-moe 24. On this 8GB 3060 Ti
// that still tries to park ~8.8GB of tensors on CUDA and OOM. --cpu-moe keeps
// every expert on RAM (~2GB VRAM measured); 16k ctx was tested generating.
function ornithWithFallbackArgs(ggufPath?: string): string[] {
  return llamaWithFallbackArgs(
    ggufPath,
    ORNITH_DEFAULT_GGUF,
    "Ornith-1.5-35B",
    [
      "-cnv",
      "-ngl 99",
      "--cpu-moe",
      "-c 16384",
      "-fa on",
      "--jinja",
      "--cache-type-k q8_0",
      "--cache-type-v q8_0",
      "-b 512",
      "-ub 256",
      "--temp 0.6",
      "--top-p 0.95",
      "--top-k 20",
      "--min-p 0.0",
      "--presence-penalty 0.0",
      "--repeat-penalty 1.0",
      "--reasoning on",
    ],
    `printf "Baixe o GGUF e aponte o arquivo na nova sessao:\\n  huggingface-cli download ${ORNITH_HF_REPO} ${ORNITH_HF_FILE}\\n" >&2; false; `,
  );
}

// Dense 27B IQ4_XS (~15GB). Speed on 8GB is GPU-layer count: 16k q8 KV plus
// --fit-target 512 left ~3GB idle and ran ~3 tok/s. Pack the card instead:
// 4k q4 KV, 128 MiB margin, 6 physical cores for the CPU layers.
function qwen27WithFallbackArgs(ggufPath?: string): string[] {
  return llamaWithFallbackArgs(
    ggufPath,
    QWEN27_DEFAULT_GGUF,
    "Qwen 27B Uncensored",
    [
      "-cnv",
      "--fit on",
      "--fit-target 128",
      "-c 4096",
      "-fa on",
      "--jinja",
      "--cache-type-k q4_0",
      "--cache-type-v q4_0",
      "-b 256",
      "-ub 128",
      "-t 6",
      "-tb 6",
      "--load-mode mmap+mlock",
      "--temp 0.6",
      "--top-p 0.95",
      "--top-k 20",
      "--min-p 0.0",
      "--presence-penalty 0.0",
      "--repeat-penalty 1.0",
      "--reasoning off",
    ],
    `printf "Baixe o GGUF (${QWEN27_HF_FILE}) e aponte o arquivo na nova sessao.\\n" >&2; false; `,
  );
}

export interface AgentProfileOptions {
  continueConversation?: boolean;
  /** Resume this exact CLI session instead of --continue/fresh. Takes
   * precedence over `continueConversation` when both are set. */
  resumeSessionId?: string;
  /** Which local model the `ollama` profile runs. Ignored by every other
   * profile. */
  ollamaModel?: string;
  /** Start `ollama run` with `--think=false` so thinking models spend the
   * context window on the answer instead of the scratchpad. */
  ollamaThinkOff?: boolean;
  /** GGUF on this machine for Ornith / Qwen. Ignored by every other profile. */
  ggufPath?: string;
}

export function buildAgentProfiles(
  options: AgentProfileOptions = {},
): Record<string, AgentProfile> {
  const shell = getShellPath();
  const continueConversation = options.continueConversation ?? false;
  const { resumeSessionId } = options;

  return {
    antigravity: {
      id: "antigravity",
      label: "Antigravity",
      command: shell,
      args: antigravityWithFallbackArgs(),
    },
    cursor: {
      id: "cursor",
      label: "Cursor Agent",
      command: shell,
      args: cursorWithFallbackArgs(continueConversation, resumeSessionId),
    },
    claude: {
      id: "claude",
      label: "Claude Code",
      command: shell,
      args: claudeWithFallbackArgs(continueConversation, resumeSessionId),
    },
    codex: {
      id: "codex",
      label: "Codex CLI",
      command: shell,
      args: codexWithFallbackArgs(resumeSessionId),
    },
    ollama: {
      id: "ollama",
      label: "Ollama (local)",
      command: shell,
      args: ollamaWithFallbackArgs(options.ollamaModel, options.ollamaThinkOff),
    },
    ornith: {
      id: "ornith",
      label: "Ornith 1.5",
      command: shell,
      args: ornithWithFallbackArgs(options.ggufPath),
    },
    qwen27: {
      id: "qwen27",
      label: "Qwen 27B",
      command: shell,
      args: qwen27WithFallbackArgs(options.ggufPath),
    },
    shell: {
      id: "shell",
      label: "Shell",
      command: shell,
      args: ["-l"],
    },
  };
}

export const DEFAULT_AGENT_PROFILE_ID = "cursor";

export function getAgentProfile(
  profileId: string,
  options?: AgentProfileOptions,
): AgentProfile {
  const profiles = buildAgentProfiles(options);
  return profiles[profileId] ?? profiles[DEFAULT_AGENT_PROFILE_ID];
}
