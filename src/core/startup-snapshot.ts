import { getCheckpoints, getRunId, isUiReady } from "./logger";

export interface StartupSnapshot {
  runId: string;
  uiReady: boolean;
  lastCheckpoint: string | null;
  documentReadyState: string;
  rootChildCount: number;
  bootScreenVisible: boolean;
  appShellVisible: boolean;
  sessionWorkspaceVisible: boolean;
  xtermCount: number;
  windowWidth: number;
  windowHeight: number;
  checkpointCount: number;
}

export function captureStartupSnapshot(): StartupSnapshot {
  const checkpoints = getCheckpoints();
  const last = checkpoints[checkpoints.length - 1];

  return {
    runId: getRunId(),
    uiReady: isUiReady(),
    lastCheckpoint: last?.stage ?? null,
    documentReadyState: document.readyState,
    rootChildCount: document.getElementById("root")?.childElementCount ?? 0,
    bootScreenVisible: document.querySelector(".boot-screen") !== null,
    appShellVisible: document.querySelector(".app-shell") !== null,
    sessionWorkspaceVisible:
      document.querySelector(".session-workspace--visible") !== null,
    xtermCount: document.querySelectorAll(".xterm").length,
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,
    checkpointCount: checkpoints.length,
  };
}
