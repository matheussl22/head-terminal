import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import {
  checkpoint,
  getCheckpoints,
  getLastCheckpoint,
  getRunId,
  initLogger,
} from "./logger";

describe("logger", () => {
  beforeEach(() => {
    initLogger({ runId: "test-run-id", channel: "dev" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("stores checkpoints in order", () => {
    const before = getCheckpoints().length;
    checkpoint("js.bootstrap.begin");
    checkpoint("js.bootstrap.cwd_ok", { cwd: "/tmp" });

    const checkpoints = getCheckpoints().slice(before);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]?.stage).toBe("js.bootstrap.begin");
    expect(checkpoints[1]?.stage).toBe("js.bootstrap.cwd_ok");
    expect(checkpoints[1]?.meta).toEqual({ cwd: "/tmp" });
  });

  it("returns last checkpoint", () => {
    checkpoint("checkpoint.a");
    checkpoint("checkpoint.b");
    expect(getLastCheckpoint()?.stage).toBe("checkpoint.b");
  });

  it("exposes run id after init", () => {
    expect(getRunId()).toBe("test-run-id");
  });
});
