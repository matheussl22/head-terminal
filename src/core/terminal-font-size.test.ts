// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

import { registerPaneFitter, unregisterPaneFitter } from "./pane-fit-registry";
import { createEmptySession, useSessionStore } from "./session-manager";
import { registerTerminal, unregisterTerminal } from "./terminal-registry";
import { applyFontSize } from "./terminal-font-size";
import { loadFontSize, saveFontSize } from "./ui-preferences";

function fakeTerminal(): Terminal {
  return { options: { fontSize: 12 } } as unknown as Terminal;
}

// The settings field saved the size and nothing else: the panes already on
// screen kept their font until the app was restarted.
describe("applyFontSize", () => {
  let paneId: string;
  const terminal = fakeTerminal();
  const fit = vi.fn();

  beforeEach(() => {
    (window as unknown as { headTerminal: unknown }).headTerminal = {
      workspace: { save: () => Promise.resolve(), load: () => Promise.resolve(null) },
      diagnostics: { appendEvent: () => undefined, appendCheckpoint: () => undefined },
    };
    useSessionStore.setState(useSessionStore.getInitialState(), true);
    const session = createEmptySession({ id: "one", title: "one", cwd: "/tmp", agentProfileId: "claude" });
    useSessionStore.getState().addSession(session);
    useSessionStore.getState().setActiveSessionId("one");
    paneId = useSessionStore.getState().getTargetPaneIds()[0] ?? "";
    expect(paneId).not.toBe("");
    registerTerminal(paneId, { terminal });
    registerPaneFitter(paneId, fit);
    fit.mockClear();
    saveFontSize(12);
  });

  afterEach(() => {
    unregisterTerminal(paneId);
    unregisterPaneFitter(paneId);
    saveFontSize(12);
  });

  it("resizes the open terminals and refits them", () => {
    expect(applyFontSize(16)).toBe(16);
    expect(terminal.options.fontSize).toBe(16);
    expect(loadFontSize()).toBe(16);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it("clamps to the allowed range", () => {
    expect(applyFontSize(40)).toBe(24);
    expect(terminal.options.fontSize).toBe(24);
    expect(applyFontSize(2)).toBe(8);
    expect(terminal.options.fontSize).toBe(8);
  });

  it("ignores an emptied number field", () => {
    applyFontSize(16);
    expect(applyFontSize(Number.NaN)).toBe(16);
    expect(terminal.options.fontSize).toBe(16);
    expect(loadFontSize()).toBe(16);
  });
});
