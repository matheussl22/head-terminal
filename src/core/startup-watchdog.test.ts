import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("startup-watchdog", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function loadWatchdog() {
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("./startup-snapshot", () => ({
      captureStartupSnapshot: () => ({
        runId: "test",
        uiReady: false,
        lastCheckpoint: null,
        documentReadyState: "complete",
        rootChildCount: 0,
        bootScreenVisible: true,
        appShellVisible: false,
        sessionWorkspaceVisible: false,
        xtermCount: 0,
        windowWidth: 800,
        windowHeight: 600,
        checkpointCount: 0,
      }),
    }));

    const logger = await import("./logger");
    logger.initLogger({ runId: "watchdog-test", channel: "dev" });
    return import("./startup-watchdog");
  }

  it("marks ui ready via notifyUiReady", async () => {
    const { notifyUiReady, startStartupWatchdog } = await loadWatchdog();
    const { isUiReady } = await import("./logger");

    startStartupWatchdog();
    notifyUiReady();
    expect(isUiReady()).toBe(true);
  });

  it("does not start twice", async () => {
    const { startStartupWatchdog } = await loadWatchdog();
    const { isUiReady } = await import("./logger");

    startStartupWatchdog();
    startStartupWatchdog();
    vi.advanceTimersByTime(15_000);
    expect(isUiReady()).toBe(false);
  });
});
