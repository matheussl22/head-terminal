import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createQueuedPtyWriter } from "./pty-write-queue";

describe("createQueuedPtyWriter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces ordinary keystrokes after the short flush window", async () => {
    const write = vi.fn();
    const queuedWrite = createQueuedPtyWriter(write);
    queuedWrite("a");
    queuedWrite("b");
    await vi.advanceTimersByTimeAsync(3);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledWith("ab");
  });

  it("flushes control sequences and large pastes immediately", () => {
    const write = vi.fn();
    const queuedWrite = createQueuedPtyWriter(write);
    queuedWrite("pending");
    queuedWrite("\x1b[A");
    queuedWrite("x".repeat(256));
    expect(write.mock.calls).toEqual([
      ["pending"],
      ["\x1b[A"],
      ["x".repeat(256)],
    ]);
  });

  it("ignores empty writes and contains synchronous transport failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const queuedWrite = createQueuedPtyWriter(() => {
      throw new Error("transport closed");
    });
    queuedWrite("");
    queuedWrite("x");
    await vi.advanceTimersByTimeAsync(4);
    expect(consoleError).toHaveBeenCalledWith(
      "PTY write error:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("cancels buffered input and ignores writes after disposal", async () => {
    const write = vi.fn();
    const queuedWrite = createQueuedPtyWriter(write);
    queuedWrite("pending");
    queuedWrite.dispose();
    queuedWrite("late");
    await vi.advanceTimersByTimeAsync(10);
    expect(write).not.toHaveBeenCalled();
  });
});
