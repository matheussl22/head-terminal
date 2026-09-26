import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { formatShortcut } from "../../core/shortcuts";
import { getTerminal } from "../../core/terminal-registry";
import { IconMore } from "../ui/Icons";
import {
  resolveMenuPosition,
  type MenuAnchor,
  type MenuPosition,
} from "./ResumeSessionMenu";

/** Order of the menu's sections; a separator goes between two of them. */
export type PaneMenuGroup = "conversation" | "layout" | "process" | "close";

export interface PaneMenuAction {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
  shortcut?: string;
  /** `data-pane-action` of the inline header button doing the same thing.
   * The item is listed only while that button is hidden — the header's
   * container queries decide what fits, and the menu takes the rest. Actions
   * without one are always listed. */
  inline?: string;
  group: PaneMenuGroup;
  danger?: boolean;
  /** Evaluated when the menu opens. */
  disabled?: boolean | (() => boolean);
  /** Hint under the label, for what an icon's tooltip says inline. */
  hint?: string;
  /** Replaces the hint while the item is disabled: why it can't be used. */
  disabledHint?: string;
  /** Actions that move the keyboard somewhere themselves (a rename field,
   * another menu, a dialog, a pane that goes away) keep it; the others hand
   * it back to the terminal. */
  keepFocus?: boolean;
  /** `anchor` is the "⋯" trigger's box, for actions that open a popover of
   * their own next to it. */
  run: (anchor: MenuAnchor) => void;
}

interface OpenMenu {
  items: PaneMenuAction[];
  anchor: DOMRect;
  position: MenuPosition;
  /** First paint happens off-screen to measure the menu, then it is placed
   * (flipped up when it doesn't fit under the trigger). */
  measured: boolean;
}

interface PaneActionsMenuProps {
  paneId: string;
  /** "Mais ações de cc3" — the trigger's accessible name. */
  label: string;
  actions: PaneMenuAction[];
  /** Where the inline buttons live (the header), to tell which are hidden. */
  hostRef: RefObject<HTMLElement | null>;
  /** Called on every render of the open menu, so times ("há 2 min") are
   * fresh without anything ticking while it is closed. */
  renderHeader?: () => ReactNode;
  /** Makes this pane the active one (the header's own click does it, but the
   * trigger keeps that click to itself). Called before an action hands the
   * keyboard to the terminal, so what is typed there and the active-pane
   * shortcuts go to the same pane. */
  onActivate?: () => void;
}

function isShownInline(host: HTMLElement | null, action: string): boolean {
  const element = host?.querySelector<HTMLElement>(`[data-pane-action="${action}"]`);
  if (!element) {
    return false;
  }
  return typeof element.checkVisibility === "function"
    ? element.checkVisibility()
    : element.offsetParent !== null;
}

function isDisabled(action: PaneMenuAction): boolean {
  return typeof action.disabled === "function" ? action.disabled() : Boolean(action.disabled);
}

/**
 * The pane header's "⋯": whatever the header has no room for, plus the few
 * things that never had a button (restart keeping the conversation, change
 * folder, rename, even out the panes, close). Built from the same action list
 * as the inline buttons, so the two can never disagree about what an action
 * does — only about where it shows.
 */
export function PaneActionsMenu({
  paneId,
  label,
  actions,
  hostRef,
  renderHeader,
  onActivate,
}: PaneActionsMenuProps) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setMenu(null);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const open = () => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    const host = hostRef.current;
    const items = actions.filter(
      (action) => !action.inline || !isShownInline(host, action.inline),
    );
    const anchor = trigger.getBoundingClientRect();
    setMenu({
      items,
      anchor,
      position: resolveMenuPosition(anchor, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
      measured: false,
    });
  };

  // Measure once rendered, then place it for real: clamp it inside the
  // window and flip it above the trigger when there's no room below.
  useLayoutEffect(() => {
    if (!menu || menu.measured || !menuRef.current) {
      return;
    }
    const box = menuRef.current.getBoundingClientRect();
    setMenu({
      ...menu,
      measured: true,
      position: resolveMenuPosition(
        menu.anchor,
        { width: window.innerWidth, height: window.innerHeight },
        { width: box.width, height: box.height },
      ),
    });
  }, [menu]);

  // Opening puts the keyboard on the first item, like a native menu.
  const measured = menu?.measured ?? false;
  const itemCount = menu?.items.length ?? 0;
  useEffect(() => {
    if (measured) {
      itemRefs.current
        .slice(0, itemCount)
        .find((item) => item && !item.disabled)
        ?.focus();
    }
  }, [measured, itemCount]);

  useEffect(() => {
    if (!menu) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // The trigger toggles on its own click; closing here would reopen it.
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      close(false);
    };
    // A resized window leaves the menu hanging where the trigger used to be.
    const onResize = () => close(false);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onResize);
    };
  }, [menu, close]);

  const runItem = (action: PaneMenuAction) => {
    if (isDisabled(action)) {
      return;
    }
    const anchor = menu?.anchor ?? triggerRef.current?.getBoundingClientRect();
    setMenu(null);
    if (anchor) {
      action.run(anchor);
    }
    // Only here: an action that keeps the keyboard (rename, history) would
    // lose it to the terminal once the active pane changes.
    if (!action.keepFocus) {
      onActivate?.();
      requestAnimationFrame(() => getTerminal(paneId)?.terminal.focus());
    }
  };

  const moveFocus = (step: number | "first" | "last") => {
    const items = itemRefs.current.slice(0, menu?.items.length ?? 0).filter(
      (item): item is HTMLButtonElement => Boolean(item && !item.disabled),
    );
    if (items.length === 0) {
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    // With the menu itself focused (no item yet), down starts at the top and
    // up at the bottom.
    const next =
      step === "first" || (current < 0 && typeof step === "number" && step > 0)
        ? 0
        : step === "last" || current < 0
          ? items.length - 1
          : (current + step + items.length) % items.length;
    items[next].focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Nothing typed in the menu may reach the app shortcuts or the terminal.
    event.stopPropagation();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(-1);
        break;
      case "Home":
        event.preventDefault();
        moveFocus("first");
        break;
      case "End":
        event.preventDefault();
        moveFocus("last");
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        event.preventDefault();
        close(true);
        break;
      default:
        break;
    }
  };

  let previousGroup: PaneMenuGroup | null = null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={
          menu
            ? "terminal-pane-header__action terminal-pane-header__more terminal-pane-header__more--open"
            : "terminal-pane-header__action terminal-pane-header__more"
        }
        data-pane-action="more"
        title="Mais ações"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-controls={menu ? menuId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (menu) {
            close(false);
          } else {
            open();
          }
        }}
        onKeyDown={(event) => {
          if (!menu && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            event.stopPropagation();
            open();
          }
        }}
      >
        <IconMore size={15} />
      </button>
      {menu && (
        <div
          ref={menuRef}
          id={menuId}
          className="pane-actions-menu"
          role="menu"
          aria-label={label}
          // Focusable so a click on something that isn't an item (the status
          // header, a separator, a disabled item) can't drop the keyboard to
          // <body>, where Esc and the arrows no longer reach the menu.
          tabIndex={-1}
          style={{
            right: menu.position.right,
            top: menu.position.top,
            // The measuring pass needs the natural height — clamped to the
            // room below, a long menu would never look like it needs to flip.
            maxHeight: menu.measured ? menu.position.maxHeight : undefined,
            visibility: menu.measured ? undefined : "hidden",
          }}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => {
            // Enabled items take the focus themselves. Anywhere else the
            // highlighted item keeps it, so the arrows continue from there.
            if ((event.target as HTMLElement).closest("button:not(:disabled)")) {
              return;
            }
            event.preventDefault();
            if (!menuRef.current?.contains(document.activeElement)) {
              menuRef.current?.focus();
            }
          }}
          onKeyDown={onMenuKeyDown}
        >
          {renderHeader && (
            <div className="pane-actions-menu__header" role="presentation">
              {renderHeader()}
            </div>
          )}
          {menu.items.map((action, index) => {
            const Icon = action.icon;
            const separator = previousGroup !== null && previousGroup !== action.group;
            previousGroup = action.group;
            const disabled = isDisabled(action);
            const hint = disabled && action.disabledHint ? action.disabledHint : action.hint;
            return (
              <div key={action.id} className="pane-actions-menu__entry" role="none">
                {separator && <div className="pane-actions-menu__separator" role="separator" />}
                <button
                  ref={(element) => {
                    itemRefs.current[index] = element;
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  disabled={disabled}
                  className={
                    action.danger
                      ? "pane-actions-menu__item pane-actions-menu__item--danger"
                      : "pane-actions-menu__item"
                  }
                  onClick={() => runItem(action)}
                  onPointerMove={(event) => {
                    // Pointer and keyboard share one highlight: hovering an
                    // item focuses it, so the arrows continue from there.
                    if (document.activeElement !== event.currentTarget) {
                      event.currentTarget.focus();
                    }
                  }}
                >
                  <span className="pane-actions-menu__icon">
                    <Icon size={14} />
                  </span>
                  <span className="pane-actions-menu__text">
                    <span className="pane-actions-menu__label">{action.label}</span>
                    {hint && <span className="pane-actions-menu__hint">{hint}</span>}
                  </span>
                  {action.shortcut && (
                    <kbd className="pane-actions-menu__shortcut">
                      {formatShortcut(action.shortcut)}
                    </kbd>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
