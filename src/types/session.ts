export type SessionStatus = "starting" | "running" | "exited";

export type SplitDirection = "horizontal" | "vertical";

export interface PaneLayoutNode {
  kind: "pane";
  paneId: string;
  /** This terminal's own working directory. Absent: the session's `cwd`. */
  cwd?: string;
}

export type LayoutNode =
  | PaneLayoutNode
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
  /** Default working directory: what a pane opens in unless it has its own. */
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
