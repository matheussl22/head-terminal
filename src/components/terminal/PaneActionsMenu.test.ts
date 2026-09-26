// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerTerminal, unregisterTerminal } from "../../core/terminal-registry";
import { PaneActionsMenu, type PaneMenuAction } from "./PaneActionsMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NoIcon = () => null;

function action(overrides: Partial<PaneMenuAction> & { id: string }): PaneMenuAction {
  return { label: overrides.id, icon: NoIcon, group: "process", run: vi.fn(), ...overrides };
}

describe("PaneActionsMenu", () => {
  let host: HTMLDivElement;
  let root: Root;
  let focusTerminal: ReturnType<typeof vi.fn>;
  let onHeaderClick: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    focusTerminal = vi.fn();
    onHeaderClick = vi.fn();
    registerTerminal("B", { terminal: { focus: focusTerminal } as unknown as Terminal });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    unregisterTerminal("B");
  });

  async function render(actions: PaneMenuAction[], onActivate?: () => void) {
    const hostRef = createRef<HTMLDivElement>();
    await act(async () => {
      root.render(
        // The pane header: its click is what activates the pane.
        createElement(
          "div",
          { ref: hostRef, onClick: onHeaderClick },
          createElement(PaneActionsMenu, {
            paneId: "B",
            label: "Mais ações de cc2",
            actions,
            hostRef,
            onActivate,
            renderHeader: () => createElement("div", { className: "status" }, "Pronto"),
          }),
        ),
      );
    });
  }

  async function openMenu() {
    const trigger = host.querySelector<HTMLButtonElement>('[data-pane-action="more"]')!;
    await act(async () => trigger.click());
    const menu = host.querySelector<HTMLDivElement>('[role="menu"]');
    expect(menu).toBeTruthy();
    return menu!;
  }

  function item(label: string): HTMLButtonElement {
    return [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (button) => button.textContent?.includes(label),
    )!;
  }

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

  it("activates an inactive pane before handing the keyboard to its terminal", async () => {
    // Pane A is active; ⋯ on pane B → "Reiniciar com nova conversa". The
    // trigger keeps its click from the header, so without onActivate B's
    // terminal got the keyboard while A stayed the active pane (and took
    // Ctrl+Shift+M, F9 and the palette's commands).
    const onActivate = vi.fn();
    const restart = action({ id: "restart", label: "Reiniciar com nova conversa" });
    await render([restart], onActivate);
    await openMenu();

    await act(async () => item("Reiniciar com nova conversa").click());
    await nextFrame();

    expect(restart.run).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(focusTerminal).toHaveBeenCalled();
    expect(onHeaderClick).not.toHaveBeenCalled();
  });

  it("leaves the active pane alone for actions that keep the keyboard", async () => {
    // Rename and history put the keyboard in a field or list of their own;
    // activating the pane would make AppShell move it back to the terminal.
    const onActivate = vi.fn();
    const rename = action({ id: "rename", label: "Renomear conversa", keepFocus: true });
    await render([rename], onActivate);
    await openMenu();

    await act(async () => item("Renomear conversa").click());
    await nextFrame();

    expect(rename.run).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
    expect(focusTerminal).not.toHaveBeenCalled();
  });

  it("keeps the keyboard in the menu when a click lands between items", async () => {
    // A click on the status header, a separator or a disabled item used to
    // drop focus to <body>: the menu stayed open, deaf to Esc and the arrows.
    await render([
      action({ id: "equalize", label: "Distribuir terminais igualmente", disabled: true }),
      action({ id: "first", label: "Primeira" }),
      action({ id: "last", label: "Última" }),
    ]);
    const menu = await openMenu();
    expect(menu.tabIndex).toBe(-1);

    const header = menu.querySelector<HTMLElement>(".pane-actions-menu__header")!;
    const onHeader = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => {
      header.dispatchEvent(onHeader);
    });
    expect(onHeader.defaultPrevented).toBe(true);

    const onDisabled = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => {
      item("Distribuir terminais igualmente").dispatchEvent(onDisabled);
    });
    expect(onDisabled.defaultPrevented).toBe(true);

    // An enabled item still takes the focus the normal way.
    const onItem = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => {
      item("Primeira").dispatchEvent(onItem);
    });
    expect(onItem.defaultPrevented).toBe(false);
  });

  it("navigates and closes from the menu itself when no item has focus", async () => {
    await render([action({ id: "first", label: "Primeira" }), action({ id: "last", label: "Última" })]);
    const menu = await openMenu();

    // Where Chromium puts the focus after a click on a non-item area.
    act(() => menu.focus());
    act(() => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(document.activeElement).toBe(item("Última"));

    act(() => menu.focus());
    act(() => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(item("Primeira"));

    act(() => menu.focus());
    act(() => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-pane-action="more"]'));
  });
});
