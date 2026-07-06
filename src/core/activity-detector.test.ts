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

  it("detecta prompt de aprovação e não decai para idle no silêncio", () => {
    const changes: string[] = [];
    const detector = new ActivityDetector((activity) => changes.push(activity));

    detector.onRunning();
    detector.onData("⠋ Editing file...\n");
    detector.onData("Do you want to make this edit?\n❯ 1. Yes\n  2. No\n");
    expect(changes[changes.length - 1]).toBe("waiting_input");

    vi.advanceTimersByTime(10_000);
    expect(changes[changes.length - 1]).toBe("waiting_input");
  });

  it("volta a working quando o prompt de aprovação sai do fim do buffer", () => {
    const changes: string[] = [];
    const detector = new ActivityDetector((activity) => changes.push(activity));

    detector.onRunning();
    detector.onData("Do you want to proceed?\n❯ 1. Yes\n");
    expect(changes[changes.length - 1]).toBe("waiting_input");

    detector.onData(`⠙ Running command...\n${"x".repeat(500)}`);
    expect(changes[changes.length - 1]).toBe("working");
  });

  it("marks error on non-zero exit", () => {
    const changes: string[] = [];
    const detector = new ActivityDetector((activity) => changes.push(activity));

    detector.onRunning();
    detector.onExit(1);

    expect(changes).toContain("error");
  });
});
