import { describe, expect, it, vi } from "vitest";

import {
  answerKeyboardProtocolQuery,
  KEYBOARD_PROTOCOL_REPLY,
  type KeyQueryTerminal,
} from "./terminal-key-query";

type CsiCallback = (params: (number | number[])[]) => boolean;

function fakeTerminal() {
  const handlers = new Map<string, CsiCallback>();
  const dispose = vi.fn();
  const input = vi.fn<(data: string, wasUserInput?: boolean) => void>();
  const terminal: KeyQueryTerminal = {
    parser: {
      registerCsiHandler(id, callback) {
        handlers.set(`${id.prefix ?? ""}${id.final}`, callback);
        return { dispose };
      },
    },
    input,
  };
  return { terminal, handlers, dispose, input };
}

// Claude Code asks `CSI ? u` at startup; unanswered, its "send now" hint
// names ctrl+x ctrl+s although Ctrl+Enter already reaches it from a macOS
// pane.
describe("answerKeyboardProtocolQuery", () => {
  it("answers the kitty keyboard query on macOS, as a terminal reply", () => {
    const { terminal, handlers, input } = fakeTerminal();
    answerKeyboardProtocolQuery(terminal, true);
    const handler = handlers.get("?u");
    expect(handler).toBeDefined();
    expect(handler?.([])).toBe(true);
    expect(input).toHaveBeenCalledWith(KEYBOARD_PROTOCOL_REPLY, false);
    expect(KEYBOARD_PROTOCOL_REPLY).toBe("\x1b[?0u");
  });

  it("stays quiet where Ctrl+Enter is still a bare Enter", () => {
    const { terminal, handlers, input } = fakeTerminal();
    answerKeyboardProtocolQuery(terminal, false).dispose();
    expect(handlers.size).toBe(0);
    expect(input).not.toHaveBeenCalled();
  });

  it("unregisters on dispose", () => {
    const { terminal, dispose } = fakeTerminal();
    answerKeyboardProtocolQuery(terminal, true).dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
