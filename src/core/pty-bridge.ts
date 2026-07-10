import type { IDisposable, IPty } from "tauri-pty";
import { spawn } from "tauri-pty";

import type { AgentProfile } from "../config/agents";
import { buildPtyEnv } from "./pty-env";
import { createQueuedPtyWriter } from "./pty-write-queue";

export interface PtySpawnOptions {
  profile: AgentProfile;
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export interface PtyBridge {
  pty: IPty;
  write: (data: string) => void;
  dispose: () => void;
}

export function createPtyBridge(options: PtySpawnOptions): PtyBridge {
  const listeners: IDisposable[] = [];

  const cols = options.cols > 0 ? options.cols : 80;
  const rows = options.rows > 0 ? options.rows : 24;

  const pty = spawn(options.profile.command, options.profile.args, {
    cols,
    rows,
    cwd: options.cwd,
    name: "xterm-256color",
    env: buildPtyEnv(options.env),
  });

  const write = createQueuedPtyWriter(pty);

  return {
    pty,
    write,
    dispose: () => {
      listeners.forEach((listener) => listener.dispose());
      try {
        pty.kill();
      } catch {
        // Process may already be gone.
      }
    },
  };
}

export function attachPtyDataListener(
  pty: IPty,
  onData: (data: Uint8Array) => void,
): IDisposable {
  return pty.onData(onData);
}

export function attachPtyExitListener(
  pty: IPty,
  onExit: (exitCode: number) => void,
): IDisposable {
  return pty.onExit(({ exitCode }) => onExit(exitCode));
}
