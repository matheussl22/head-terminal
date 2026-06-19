import { invoke } from "@tauri-apps/api/core";
import type { IPty } from "tauri-pty";

import { recordPtyWriteLatency } from "./dev-metrics";

interface TauriPtyHandle extends IPty {
  pid: number;
  _init: Promise<void>;
}

const FLUSH_MS = 4;
const ESCAPE_PREFIX = "\x1b";

function containsEscapeSequence(data: string): boolean {
  return data.includes(ESCAPE_PREFIX);
}

export function createQueuedPtyWriter(pty: IPty): (data: string) => void {
  const handle = pty as TauriPtyHandle;
  let chain = Promise.resolve();
  let buffer = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    flushTimer = null;
    const payload = buffer;
    buffer = "";

    if (!payload) {
      return;
    }

    const startedAt = performance.now();
    chain = chain
      .then(async () => {
        await handle._init;
        await invoke("plugin:pty|write", { pid: handle.pid, data: payload });
        recordPtyWriteLatency(performance.now() - startedAt);
      })
      .catch((error) => {
        console.error("PTY write error:", error);
      });
  };

  const scheduleFlush = () => {
    if (flushTimer !== null) {
      return;
    }

    flushTimer = setTimeout(flush, FLUSH_MS);
  };

  return (data: string) => {
    if (!data) {
      return;
    }

    if (containsEscapeSequence(data)) {
      if (buffer) {
        flush();
      }

      buffer = data;
      flush();
      return;
    }

    buffer += data;

    if (buffer.length >= 256) {
      flush();
      return;
    }

    scheduleFlush();
  };
}
