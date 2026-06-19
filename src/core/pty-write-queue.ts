import { invoke } from "@tauri-apps/api/core";
import type { IPty } from "tauri-pty";

interface TauriPtyHandle extends IPty {
  pid: number;
  _init: Promise<void>;
}

export function createQueuedPtyWriter(pty: IPty): (data: string) => void {
  const handle = pty as TauriPtyHandle;
  let chain = Promise.resolve();

  return (data: string) => {
    if (!data) {
      return;
    }

    chain = chain
      .then(async () => {
        await handle._init;
        await invoke("plugin:pty|write", { pid: handle.pid, data });
      })
      .catch((error) => {
        console.error("PTY write error:", error);
      });
  };
}
