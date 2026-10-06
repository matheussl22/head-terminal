export type SessionStatus = "starting" | "running" | "exited";

export type SplitDirection = "horizontal" | "vertical";

/** Árvore isolada que o Head Terminal criou para uma sessão ou terminal.
 * Guardada para saber, ao fechar, o que foi criado aqui e pode ser removido —
 * um worktree que o usuário abriu na mão nunca ganha esta marca. */
export interface WorktreeRef {
  /** Pasta do worktree: é ela que a sessão/terminal abre. */
  path: string;
  branch: string;
  /** Repositório principal de onde a árvore saiu. */
  mainRepoRoot: string;
}

export interface PaneLayoutNode {
  kind: "pane";
  paneId: string;
  /** This terminal's own working directory. Absent: the session's `cwd`. */
  cwd?: string;
  /** Set when `cwd` is a worktree this app created for this terminal alone. */
  worktree?: WorktreeRef;
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
  /** Set when `cwd` is a worktree this app created for this session. */
  worktree?: WorktreeRef;
  agentProfileId: string;
  claudeAccountId?: string;
  /** Local model this session runs, for the `ollama` profile only. */
  ollamaModel?: string;
  /** When true, the ollama pane starts with `--think=false`. */
  ollamaThinkOff?: boolean;
  /** GGUF on this machine for llama.cpp profiles (Ornith / Qwen). */
  ggufPath?: string;
  /** Windows `shell` sessions only: open this WSL distribution instead of
   * PowerShell. Absent means PowerShell. */
  wslDistro?: string;
  layout: LayoutNode;
  pinned?: boolean;
  /** The project this session belongs to. Only read in projects mode; kept
   * while the mode is off so turning it back on restores the grouping. */
  projectId?: string;
}

/** A set of sessions in projects mode: on screen on its own, or under its
 * header in the grouped view. */
export interface Project {
  id: string;
  name: string;
  /** Where the project's new sessions open. Absent: the app's default. */
  cwd?: string;
  /** The session it was showing, for when the user comes back to it. */
  lastSessionId?: string;
  /** Grouped view: its sessions are folded under its header. */
  collapsed?: boolean;
}
