// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { collectPaneIds } from "../../core/session-layout";
import {
  createEmptySession,
  createPaneRuntime,
  useSessionStore,
  type PaneRuntime,
} from "../../core/session-manager";
import { TerminalPaneHeader } from "./TerminalPaneChrome";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What the pane's container queries hid at the width under test. jsdom has
 * no layout, so visibility is whatever the test says it is. */
let hiddenSelectors: string[] = [];
const originalCheckVisibility = HTMLElement.prototype.checkVisibility;

describe("TerminalPaneHeader", () => {
  let host: HTMLDivElement;
  let root: Root;
  let paneId: string;
  let onFocus: Mock<() => void>;
  let restartPane: Mock<(paneId: string, options?: { continueConversation?: boolean }) => void>;

  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    HTMLElement.prototype.checkVisibility = function checkVisibility(this: HTMLElement) {
      return !hiddenSelectors.some((selector) => this.matches(selector));
    };
    hiddenSelectors = [];

    useSessionStore.setState(useSessionStore.getInitialState(), true);
    const session = createEmptySession({
      id: "s",
      title: "s",
      cwd: "C:/repo",
      agentProfileId: "claude",
    });
    useSessionStore.getState().addSession(session);
    [paneId] = collectPaneIds(session.layout);
    restartPane = vi.fn();
    useSessionStore.setState({ restartPane });
    onFocus = vi.fn();

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    HTMLElement.prototype.checkVisibility = originalCheckVisibility;
    vi.unstubAllGlobals();
  });

  function setRuntime(patch: Partial<PaneRuntime>) {
    useSessionStore.setState((state) => ({
      paneRuntime: { ...state.paneRuntime, [paneId]: { ...createPaneRuntime(), ...patch } },
    }));
  }

  function nameConversation(name: string) {
    useSessionStore.setState((state) => ({
      paneResumeAnchors: { ...state.paneResumeAnchors, [paneId]: "conv-1" },
      conversationLabels: { ...state.conversationLabels, "conv-1": name },
    }));
  }

  async function render() {
    await act(async () => {
      root.render(
        createElement(TerminalPaneHeader, {
          paneId,
          sessionId: "s",
          cwd: "C:/repo",
          agentProfileId: "claude",
          paneIndex: 0,
          paneCount: 2,
          onScreenPaneCount: 2,
          isActive: false,
          isMaximized: false,
          onFocus,
          onClose: vi.fn(),
        }),
      );
    });
  }

  function header(): HTMLElement {
    return host.querySelector<HTMLElement>(".terminal-pane-header")!;
  }

  async function openMenu() {
    const trigger = host.querySelector<HTMLButtonElement>('[data-pane-action="more"]')!;
    await act(async () => trigger.click());
    return host.querySelector<HTMLElement>(".pane-actions-menu")!;
  }

  async function pick(label: string) {
    const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (button) => button.textContent?.includes(label),
    );
    expect(item, label).toBeTruthy();
    await act(async () => item!.click());
  }

  function statusTooltip(): string {
    const chip = host.querySelector<HTMLElement>(".terminal-pane-header__status")!;
    // React derives onPointerEnter from pointerover (jsdom has no
    // PointerEvent; the type is what matters).
    act(() => {
      chip.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: null }));
    });
    return chip.title;
  }

  it('restarts on a new conversation from the ⋯ "Reiniciar com nova conversa"', async () => {
    // A narrow pane (< 800px) has no inline restart button. The menu entry
    // called restartPane(pane) with no options, which keeps a restored or
    // resumed pane on its old conversation (--resume <old id>).
    hiddenSelectors = ['[data-pane-action="restart"]'];
    await render();
    await openMenu();

    await pick("Reiniciar com nova conversa");

    expect(restartPane).toHaveBeenCalledWith(paneId, { continueConversation: false });
  });

  it("activates the pane when a ⋯ action hands the keyboard to its terminal", async () => {
    hiddenSelectors = ['[data-pane-action="restart"]'];
    await render();
    await openMenu();

    await pick("Reiniciar continuando a conversa");

    expect(restartPane).toHaveBeenCalledWith(paneId, { continueConversation: true });
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it("tells a voluntary /exit from a crash on the restart-agent button", async () => {
    setRuntime({ status: "running", activity: "agent_fallback", agentExitCode: 0 });
    await render();
    const button = () =>
      host.querySelector<HTMLButtonElement>('[data-pane-action="restart-agent"]')!;
    expect(button().title).toBe(
      "Agent saiu — shell ativo. Nova conversa. Segure Shift para continuar a anterior.",
    );

    act(() => setRuntime({ status: "running", activity: "agent_fallback", agentExitCode: 137 }));
    expect(button().title).toBe(
      "Agent caiu (código 137) — shell ativo. Nova conversa. Segure Shift para continuar a anterior.",
    );
  });

  describe("conversation name with no room in the header (10 columns)", () => {
    beforeEach(() => {
      nameConversation("Refatorar o login");
    });

    it("goes into the status tooltip and the ⋯ header", async () => {
      hiddenSelectors = [".terminal-pane-header__conversation"];
      await render();

      expect(statusTooltip()).toContain("Conversa: Refatorar o login");
      const menu = await openMenu();
      expect(menu.querySelector(".pane-actions-menu__header")?.textContent).toContain(
        "Conversa: Refatorar o login",
      );
    });

    it("stays out of both while the header shows it", async () => {
      await render();

      expect(statusTooltip()).not.toContain("Conversa:");
      const menu = await openMenu();
      expect(menu.querySelector(".pane-actions-menu__conversation")).toBeNull();
    });

    it('says "nova conversa" before the conversation has a name', async () => {
      useSessionStore.setState({ paneResumeAnchors: {}, conversationLabels: {} });
      hiddenSelectors = [".terminal-pane-header__conversation"];
      await render();

      expect(statusTooltip()).toContain("Conversa: nova conversa");
    });
  });

  describe("renaming", () => {
    it("keeps folder and branch in place for an inline rename", async () => {
      // A wide pane: the name is clicked where it is. Hiding the pills moved
      // the field up to ~340px away from the click.
      await render();
      const name = host.querySelector<HTMLButtonElement>(".terminal-pane-header__conversation")!;

      await act(async () => name.click());

      expect(host.querySelector(".terminal-pane-header__conversation-input")).toBeTruthy();
      expect(header().classList.contains("terminal-pane-header--renaming")).toBe(true);
      expect(header().classList.contains("terminal-pane-header--renaming-menu")).toBe(false);
      expect(onFocus).not.toHaveBeenCalled();
    });

    it("gives the field the folder and branch's room when started from ⋯", async () => {
      await render();
      await openMenu();

      await pick("Renomear conversa");

      const input = host.querySelector<HTMLInputElement>(".terminal-pane-header__conversation-input");
      expect(input).toBeTruthy();
      expect(header().classList.contains("terminal-pane-header--renaming-menu")).toBe(true);
      // Rename keeps the keyboard: activating the pane would pull it back to
      // the terminal.
      expect(onFocus).not.toHaveBeenCalled();

      await act(async () => {
        input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(header().classList.contains("terminal-pane-header--renaming")).toBe(false);
      expect(header().classList.contains("terminal-pane-header--renaming-menu")).toBe(false);
    });
  });
});
