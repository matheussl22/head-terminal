import { recordPtyWriteLatency } from "./dev-metrics";

const FLUSH_MS = 4;
const ESCAPE_PREFIX = "\x1b";

function containsEscapeSequence(data: string): boolean {
  return data.includes(ESCAPE_PREFIX);
}

export interface QueuedPtyWriter {
  (data: string): void;
  dispose(): void;
}

export function createQueuedPtyWriter(
  writeRaw: (data: string) => void,
): QueuedPtyWriter {
  let buffer = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const flush = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
    }
    flushTimer = null;
    const payload = buffer;
    buffer = "";

    if (!payload || disposed) {
      return;
    }

    const startedAt = performance.now();
    try {
      writeRaw(payload);
      recordPtyWriteLatency(performance.now() - startedAt);
    } catch (error) {
      console.error("PTY write error:", error);
    }
  };

  const scheduleFlush = () => {
    if (flushTimer !== null) {
      return;
    }

    flushTimer = setTimeout(flush, FLUSH_MS);
  };

  const write: QueuedPtyWriter = (data: string) => {
    if (!data || disposed) {
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

  write.dispose = () => {
    disposed = true;
    buffer = "";
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  return write;
}
