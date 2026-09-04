/**
 * What every agent profile builder shares, whichever shell it targets: the
 * profile shape, the sentinels the pane listens for, and the model/GGUF
 * defaults. The POSIX (zsh) and Windows (PowerShell) builders live next door.
 */

export interface AgentProfile {
  id: string;
  label: string;
  command: string;
  args: string[];
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

export const DEFAULT_AGENT_PROFILE_ID = "cursor";

/**
 * Abstract shell name a Windows pane asks for. The main process resolves it
 * to PowerShell 7 or Windows PowerShell 5.1, whichever is installed.
 */
export const WINDOWS_SHELL_COMMAND = "powershell";

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
export const RESUME_FAILURE_WINDOW_SECONDS = 30;

// Session ids picked from the resume dropdown are always claude/codex/cursor
// UUIDs (see electron/services/agent-sessions-service.ts) or codex's rollout
// id — this guards the shell interpolation against anything else that might
// end up here, defense in depth rather than trusting the IPC boundary.
const RESUMABLE_SESSION_ID = /^[0-9a-f-]{8,64}$/i;

export function sanitizeResumeSessionId(resumeSessionId?: string): string | undefined {
  return resumeSessionId && RESUMABLE_SESSION_ID.test(resumeSessionId)
    ? resumeSessionId
    : undefined;
}

// `ollama run <model>` — model names look like `namespace/name:tag`. The value
// reaches here from the create-session dialog, where the user can type it by
// hand, so it is validated before landing in a shell rather than trusted.
const OLLAMA_MODEL =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*(:[A-Za-z0-9._-]+)?$/;

export function sanitizeOllamaModel(model?: string): string | undefined {
  const trimmed = model?.trim();
  return trimmed && trimmed.length <= 128 && OLLAMA_MODEL.test(trimmed)
    ? trimmed
    : undefined;
}

/** llama.cpp flags on Ornith/Qwen were measured on this card. Other VRAM
 * sizes need their own ngl / cpu-moe / ctx — do not copy these blindly. */
export const LLAMA_HARDWARE_PROFILE = "RTX 3060 Ti 8 GB";

/** GGUFs on the Dados volume (D:). The POSIX spelling is what a Linux pane
 * sees; the Windows builder derives `D:\models\…` from it. Override in the
 * create-session dialog; the weights themselves are never in git. */
export const ORNITH_DEFAULT_GGUF =
  "/mnt/d/models/ornith-1.5-35b/Ornith-1.5-35B-Q4_K_M.gguf";
export const QWEN27_DEFAULT_GGUF =
  "/mnt/d/models/qwen38-27b-uncensored/Qwen3.8-27B-Uncensored-IQ4_XS.gguf";

export const ORNITH_HF_REPO = "ornith-ai/Ornith-1.5-35B-A3B-GGUF";
export const ORNITH_HF_FILE = "Ornith-1.5-35B-Q4_K_M.gguf";
export const QWEN27_HF_FILE = "Qwen3.8-27B-Uncensored-IQ4_XS.gguf";

export const GGUF_PATH_MAX = 4_096;

// Tweet config assumed a 12GB 3060 with --n-cpu-moe 24. On this 8GB 3060 Ti
// that still tries to park ~8.8GB of tensors on CUDA and OOM. --cpu-moe keeps
// every expert on RAM (~2GB VRAM measured); 16k ctx was tested generating.
export const ORNITH_FLAGS = [
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
] as const;

// Dense 27B IQ4_XS (~15GB). Speed on 8GB is GPU-layer count: 16k q8 KV plus
// --fit-target 512 left ~3GB idle and ran ~3 tok/s. Pack the card instead:
// 4k q4 KV, 128 MiB margin, 6 physical cores for the CPU layers.
export const QWEN27_FLAGS = [
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
] as const;

export const AGENT_PROFILE_LABELS: Record<string, string> = {
  antigravity: "Antigravity",
  cursor: "Cursor Agent",
  claude: "Claude Code",
  codex: "Codex CLI",
  ollama: "Ollama (local)",
  ornith: "Ornith 1.5",
  qwen27: "Qwen 27B",
  shell: "Shell",
};
