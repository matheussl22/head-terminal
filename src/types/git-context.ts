export type GitContextSource = "watcher" | "poll" | "pty" | "initial";

export interface GitContext {
  repoRoot: string | null;
  branch: string | null;
  headShort: string | null;
  headRef: string;
  isDirty: boolean;
  lastTouchedPath: string | null;
  lastTouchedAt: number | null;
  source: GitContextSource;
}

export const EMPTY_GIT_CONTEXT: GitContext = {
  repoRoot: null,
  branch: null,
  headShort: null,
  headRef: "",
  isDirty: false,
  lastTouchedPath: null,
  lastTouchedAt: null,
  source: "initial",
};
