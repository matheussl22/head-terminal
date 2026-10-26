import type { IDisposable } from "@xterm/xterm";

import { isMacHost } from "./platform-info";

/**
 * The kitty keyboard protocol's query (`CSI ? u`) and the reply that says
 * "no flags are set" — a terminal that doesn't know the protocol says
 * nothing at all.
 */
export const KEYBOARD_PROTOCOL_REPLY = "\x1b[?0u";

/** The slice of xterm's Terminal the answer needs. */
export interface KeyQueryTerminal {
  parser: {
    registerCsiHandler(
      id: { prefix?: string; final: string },
      callback: (params: (number | number[])[]) => boolean,
    ): IDisposable;
  };
  input(data: string, wasUserInput?: boolean): void;
}

/**
 * Claude Code asks the terminal `CSI ? u` at startup and, with no reply,
 * takes it for one that can't tell Ctrl+Enter from Enter: its "send now"
 * hint then names the `ctrl+x ctrl+s` chord, and the fleet view keeps
 * Ctrl+Enter off. xterm doesn't answer, so a macOS pane — where Ctrl+Enter
 * already goes out as the CSI-u key Claude Code reads for it (see
 * terminal-factory) — answers for it. The flags Claude Code then pushes
 * (`CSI > 5 u`, `CSI > 4;2m`) and pops on exit are sequences xterm ignores;
 * keys keep their legacy encoding, which Claude Code's parser always reads.
 * Elsewhere Ctrl+Enter is still a bare Enter, so the query stays unanswered
 * and the hint keeps naming the chord that works.
 */
export function answerKeyboardProtocolQuery(
  terminal: KeyQueryTerminal,
  mac: boolean = isMacHost(),
): IDisposable {
  if (!mac) {
    return { dispose: () => undefined };
  }
  return terminal.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => {
    // Not user input: no scroll to the bottom, no "the user typed" signal.
    terminal.input(KEYBOARD_PROTOCOL_REPLY, false);
    return true;
  });
}
