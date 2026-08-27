import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

import { createRafPtyWriter } from "./terminal-factory";

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("createRafPtyWriter", () => {
  const rafQueue: FrameRequestCallback[] = [];

  beforeEach(() => {
    rafQueue.length = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushRaf(): void {
    const queued = rafQueue.splice(0);
    for (const callback of queued) {
      callback(0);
    }
  }

  it("merges pending chunks into one terminal.write per frame", () => {
    const writes: unknown[] = [];
    const onFrame = vi.fn();
    const terminal = {
      write: (data: unknown, callback?: () => void) => {
        writes.push(data);
        callback?.();
      },
    } as Pick<Terminal, "write">;

    const write = createRafPtyWriter(terminal as Terminal, onFrame);
    write(encode("hel"));
    write(encode("lo"));
    expect(writes).toEqual([]);

    flushRaf();
    expect(writes).toHaveLength(1);
    expect(new TextDecoder().decode(writes[0] as Uint8Array)).toBe("hello");
    expect(onFrame).toHaveBeenCalledWith("hello");
  });

  it("skips onFrameText while the pane is hidden but still writes", () => {
    const writes: unknown[] = [];
    const onFrame = vi.fn();
    const terminal = {
      write: (data: unknown, callback?: () => void) => {
        writes.push(data);
        callback?.();
      },
    } as Pick<Terminal, "write">;

    const write = createRafPtyWriter(
      terminal as Terminal,
      onFrame,
      () => true,
    );
    write(encode("secret"));
    flushRaf();

    expect(writes).toHaveLength(1);
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("caps a frame and continues on the next rAF", () => {
    const writes: unknown[] = [];
    const terminal = {
      write: (data: unknown, callback?: () => void) => {
        writes.push(data);
        callback?.();
      },
    } as Pick<Terminal, "write">;

    const write = createRafPtyWriter(terminal as Terminal);
    const first = new Uint8Array(150 * 1024);
    const second = new Uint8Array(150 * 1024);
    first.fill(1);
    second.fill(2);
    write(first);
    write(second);

    flushRaf();
    expect(writes).toHaveLength(1);
    expect((writes[0] as Uint8Array).byteLength).toBe(150 * 1024);

    flushRaf();
    expect(writes).toHaveLength(2);
    expect((writes[1] as Uint8Array).byteLength).toBe(150 * 1024);
  });
});
