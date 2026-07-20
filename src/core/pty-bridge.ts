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
  pty: ElectronPty;
  write: (data: string) => void;
  dispose: () => void;
}

export interface IDisposable {
  dispose(): void;
}

export interface ElectronPty {
  id: string;
  pid: number;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: Uint8Array) => void): IDisposable;
  onExit(callback: (event: { exitCode: number }) => void): IDisposable;
}

const encoder = new TextEncoder();

export async function createPtyBridge(
  options: PtySpawnOptions,
): Promise<PtyBridge> {

  const cols = options.cols > 0 ? options.cols : 80;
  const rows = options.rows > 0 ? options.rows : 24;

  const id = crypto.randomUUID();
  const handle = await window.headTerminal.terminal.spawn({
    id,
    command: options.profile.command,
    args: options.profile.args,
    cols,
    rows,
    cwd: options.cwd,
    env: buildPtyEnv(options.env),
  });

  const pty: ElectronPty = {
    id,
    pid: handle.pid,
    resize: (nextCols, nextRows) => {
      window.headTerminal.terminal.resize({
        id,
        cols: nextCols,
        rows: nextRows,
      });
    },
    kill: () => {
      void window.headTerminal.terminal.kill(id).catch(() => {
        // The process may have exited between the renderer request and main.
      });
    },
    onData: (callback) => {
      const unsubscribe = window.headTerminal.terminal.onData((event) => {
        if (event.id === id) callback(encoder.encode(event.data));
      });
      return { dispose: unsubscribe };
    },
    onExit: (callback) => {
      const unsubscribe = window.headTerminal.terminal.onExit((event) => {
        if (event.id === id) callback({ exitCode: event.exitCode });
      });
      return { dispose: unsubscribe };
    },
  };

  const write = createQueuedPtyWriter((data) => {
    window.headTerminal.terminal.write({ id, data });
  });
  let disposed = false;

  return {
    pty,
    write,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      write.dispose();
      try {
        pty.kill();
      } catch {
        // Process may already be gone.
      }
    },
  };
}

export function attachPtyDataListener(
  pty: ElectronPty,
  onData: (data: Uint8Array) => void,
): IDisposable {
  return pty.onData(onData);
}

export function attachPtyExitListener(
  pty: ElectronPty,
  onExit: (exitCode: number) => void,
): IDisposable {
  return pty.onExit(({ exitCode }) => onExit(exitCode));
}
