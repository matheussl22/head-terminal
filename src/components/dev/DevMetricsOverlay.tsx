import { useSyncExternalStore } from "react";

import {
  getDevMetrics,
  subscribeDevMetrics,
} from "../../core/dev-metrics";

export function DevMetricsOverlay() {
  const metrics = useSyncExternalStore(
    subscribeDevMetrics,
    getDevMetrics,
    getDevMetrics,
  );

  if (!import.meta.env.DEV) {
    return null;
  }

  return (
    <div className="dev-metrics" aria-hidden>
      <span>write {metrics.lastPtyWriteMs.toFixed(1)}ms</span>
      <span>read {metrics.lastPtyReadBatchBytes}B</span>
      <span>#{metrics.ptyWriteCount}/{metrics.ptyReadBatchCount}</span>
    </div>
  );
}
