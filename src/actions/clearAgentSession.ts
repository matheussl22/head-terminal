import { sendAgentCommand } from "./sendAgentCommand";
import { useSessionStore } from "../core/session-manager";

export type ClearMode = "soft" | "hard";

export function clearAgentSession(mode: ClearMode = "soft"): void {
  if (mode === "soft") {
    sendAgentCommand("/clear");
    return;
  }

  useSessionStore.getState().restartTargetPanes();
}
