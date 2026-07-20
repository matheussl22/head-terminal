import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkpoint,
  getCheckpoints,
  getLastCheckpoint,
  getRunId,
  initLogger,
  logEvent,
} from "./logger";

type DiagnosticsApi = Window["headTerminal"]["diagnostics"];

describe("logger", () => {
  beforeEach(() => {
    initLogger({ runId: "test-run-id", channel: "dev" });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
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

  it("logs safely when window and localStorage do not exist", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("localStorage", undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => logEvent("info", "headless.event", { ok: true })).not.toThrow();
    expect(consoleLog).toHaveBeenCalledOnce();
  });

  it("forwards events and checkpoints through the typed diagnostics API", () => {
    const appendEvent = vi.fn<DiagnosticsApi["appendEvent"]>();
    const appendCheckpoint = vi.fn<DiagnosticsApi["appendCheckpoint"]>();
    const diagnostics: DiagnosticsApi = {
      appendEvent,
      appendCheckpoint,
      export: vi.fn<DiagnosticsApi["export"]>(),
    };
    vi.stubGlobal("window", { headTerminal: { diagnostics } });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    logEvent("warn", "renderer.warning", { paneId: "pane:1" });
    checkpoint("renderer.ready", { panes: 2 });

    expect(appendEvent).toHaveBeenCalledTimes(2);
    expect(appendCheckpoint).toHaveBeenCalledWith({
      checkpoint: "renderer.ready",
      elapsedMs: expect.any(Number),
      metadata: { panes: 2 },
    });
  });
});
