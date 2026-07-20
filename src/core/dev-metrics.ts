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

// useSyncExternalStore compares snapshots by reference, so getDevMetrics must
// return a stable object between updates. We only rebuild the snapshot when a
// metric actually changes, otherwise repeated renders would loop forever.
let snapshot: DevMetrics = { ...metrics };

function notify(): void {
  snapshot = { ...metrics };
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
  return snapshot;
}

export function subscribeDevMetrics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
