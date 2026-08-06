import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { ActivityDetector } from "./activity-detector";

describe("ActivityDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transitions to working on output once the startup burst has settled", () => {
    const changes: string[] = [];
    const detector = new ActivityDetector((activity) => changes.push(activity));

    detector.onStarting();
    detector.onRunning();
    vi.advanceTimersByTime(1500);
    detector.onData("npm test\n");

    expect(changes).toContain("working");
  });

  it("does not flip to working while a just-spawned CLI paints its own boot chrome, however long that takes", () => {
    const changes: string[] = [];
    const detector = new ActivityDetector((activity) => changes.push(activity));

    detector.onStarting();
    detector.onRunning();

    // A slow agent boot: banner, restored conversation, more chrome — none
    // of it matching a work pattern, spread over well past any fixed grace
    // window. This is what made every pane of a lazily spawned session
    // flash "executando" on the first switch to it.
    for (let i = 0; i < 10; i += 1) {
      detector.onData(`Restoring previous conversation... chunk ${i}\n`);
      vi.advanceTimersByTime(1000);
    }

    expect(changes).not.toContain("working");
  });

  it("still reports real work that starts during the boot burst", () => {
    const changes: string[] = [];
    const detector = new ActivityDetector((activity) => changes.push(activity));

    detector.onRunning();
    detector.onData("Welcome to the agent\n");
    detector.onData("⠋ thinking...\n");

    expect(changes[changes.length - 1]).toBe("working");
  });

  it("treats a resize repaint as chrome, not work", () => {
    const changes: string[] = [];
    const detector = new ActivityDetector((activity) => changes.push(activity));

    detector.onRunning();
    vi.advanceTimersByTime(1500);

    // Pane becomes visible / split is dragged: SIGWINCH makes a full-screen
    // agent repaint everything, which is not work.
    detector.onResize();
    detector.onData("\x1b[2J\x1b[H│ agent │ ready to help you today\n");

    expect(changes).not.toContain("working");
  });

  it("goes back to reporting work after a resize burst settles", () => {
    const changes: string[] = [];
    const detector = new ActivityDetector((activity) => changes.push(activity));

    detector.onRunning();
    detector.onResize();
    detector.onData("\x1b[2J\x1b[H repainted\n");
    expect(changes).not.toContain("working");

    vi.advanceTimersByTime(1500);
    detector.onData("some later unrecognized output\n");

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

  it("não marca error num 'API Error' recuperável do agent (processo segue vivo)", () => {
    const changes: string[] = [];
    const detector = new ActivityDetector((activity) => changes.push(activity));

    detector.onRunning();
    detector.onData(
      "API Error: Server error mid-response. The response above may be incomplete.\n",
    );

    expect(changes).not.toContain("error");
  });

  it("não marca error em [ERRO] de apps (Playwright etc.) com PTY vivo", () => {
    const changes: string[] = [];
    const detector = new ActivityDetector((activity) => changes.push(activity));

    detector.onRunning();
    vi.advanceTimersByTime(1500);
    detector.onData(
      '[ERRO] em gerarComprovantePixTransferenciaMiniApp: Locator.scroll_into_view_if_needed: Error: strict mode violation\n',
    );

    expect(changes).not.toContain("error");
    expect(changes).toContain("working");
  });
});
