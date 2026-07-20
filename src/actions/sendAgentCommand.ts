import { useSessionStore } from "../core/session-manager";

function normalizeCommand(command: string): string {
  if (command.endsWith("\r") || command.endsWith("\n")) {
    return command.replace(/\n$/, "\r");
  }

  return `${command}\r`;
}

export function sendAgentCommand(command: string): void {
  const { ptyWriters, getTargetPaneIds } = useSessionStore.getState();
  const payload = normalizeCommand(command);
  const paneIds = getTargetPaneIds();

  for (const paneId of paneIds) {
    ptyWriters[paneId]?.(payload);
  }
}

export function sendTextToPane(paneId: string, text: string): void {
  const { ptyWriters } = useSessionStore.getState();
  ptyWriters[paneId]?.(text);
}
