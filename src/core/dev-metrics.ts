export interface DevMetrics {
  lastPtyWriteMs: number;
  lastPtyReadBatchBytes: number;
  ptyWriteCount: number;
  ptyReadBatchCount: number;
}

const metrics: DevMetrics = {
  lastPtyWriteMs: 0,
  lastPtyReadBatchBytes: 0,
  ptyWriteCount: 0,
  ptyReadBatchCount: 0,
};

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function recordPtyWriteLatency(ms: number): void {
  metrics.lastPtyWriteMs = ms;
  metrics.ptyWriteCount += 1;
  notify();
}

export function recordPtyReadBatch(bytes: number): void {
  metrics.lastPtyReadBatchBytes = bytes;
  metrics.ptyReadBatchCount += 1;
  notify();
}

export function getDevMetrics(): DevMetrics {
  return { ...metrics };
}

export function subscribeDevMetrics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
