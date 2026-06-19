import { useSessionStore } from "../core/session-manager";

export function clearAgentSession(): void {
  useSessionStore.getState().restartTargetPanes();
}
