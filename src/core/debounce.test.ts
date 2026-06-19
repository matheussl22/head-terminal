import { describe, expect, it, vi } from "vitest";

import { debounce } from "./debounce";

describe("debounce", () => {
  it("delays execution until the wait period elapses", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced("a");
    debounced("b");

    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("b");

    vi.useRealTimers();
  });

  it("flushes pending calls immediately", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced("pending");
    debounced.flush();

    expect(fn).toHaveBeenCalledWith("pending");
    vi.useRealTimers();
  });
});
