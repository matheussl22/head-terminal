import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { ActivityDetector } from "./activity-detector";

describe("ActivityDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transitions to working on output", () => {
    const changes: string[] = [];
    const detector = new ActivityDetector((activity) => changes.push(activity));

    detector.onStarting();
    detector.onRunning();
    detector.onData("npm test\n");

    expect(changes).toContain("working");
  });

  it("detects waiting_input after idle timeout following work", () => {
    const changes: string[] = [];
    const detector = new ActivityDetector((activity) => changes.push(activity));

    detector.onRunning();
    detector.onData("Building project...\n");
    expect(changes).toContain("working");

    vi.advanceTimersByTime(3000);
    expect(changes).toContain("waiting_input");
  });

  it("marks error on non-zero exit", () => {
    const changes: string[] = [];
    const detector = new ActivityDetector((activity) => changes.push(activity));

    detector.onRunning();
    detector.onExit(1);

    expect(changes).toContain("error");
  });
});
