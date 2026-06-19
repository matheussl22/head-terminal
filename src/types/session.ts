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
  layout: LayoutNode;
  paneStatuses: Record<string, SessionStatus>;
}
