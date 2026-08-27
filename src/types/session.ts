export type SessionStatus = "starting" | "running" | "exited";

export type SplitDirection = "horizontal" | "vertical";

export type LayoutNode =
  | { kind: "pane"; paneId: string }
  | {
      kind: "split";
      direction: SplitDirection;
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };

export interface AgentSession {
  id: string;
  title: string;
  cwd: string;
  agentProfileId: string;
  claudeAccountId?: string;
  /** Local model this session runs, for the `ollama` profile only. */
  ollamaModel?: string;
  /** When true, the ollama pane starts with `--think=false`. */
  ollamaThinkOff?: boolean;
  /** GGUF on this machine for llama.cpp profiles (Ornith / Qwen). */
  ggufPath?: string;
  layout: LayoutNode;
  pinned?: boolean;
}
