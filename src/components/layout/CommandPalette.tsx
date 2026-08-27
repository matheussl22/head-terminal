import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { sendAgentCommand } from "../../actions/sendAgentCommand";
import { PALETTE_ACTIONS } from "../../config/toolbar";
import { exportDiagnosticBundle } from "../../core/export-diagnostic";
import { useSessionStore } from "../../core/session-manager";
import { getTerminal } from "../../core/terminal-registry";
import { isVoiceInputSupported, toggleVoiceInput } from "../../core/voice-input";

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
    ),
  ).filter((element) => element.tabIndex >= 0);
}

function trapTabInside(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== "Tab") {
    return;
  }

  const focusable = getFocusable(container);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey) {
    if (active === first || !container.contains(active)) {
      event.preventDefault();
      last.focus();
    }
    return;
  }

  if (active === last || !container.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onRenameRequest: () => void;
  onSettingsRequest: () => void;
}

export function CommandPalette({
  open,
  onClose,
  onRenameRequest,
  onSettingsRequest,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const splitActivePane = useSessionStore((state) => state.splitActivePane);
  const activePaneId = useSessionStore((state) => state.activePaneId);
  const closePane = useSessionStore((state) => state.closePane);
  const available = useMemo(
    () =>
      isVoiceInputSupported()
        ? PALETTE_ACTIONS
        : PALETTE_ACTIONS.filter((action) => action.command !== "__voice_input__"),
    [],
  );
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    if (!normalized) {
      return available;
    }

    return available.filter(
      (action) =>
        action.label.toLowerCase().includes(normalized) ||
        action.command.toLowerCase().includes(normalized) ||
        action.description?.toLowerCase().includes(normalized),
    );
  }, [available, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [available, query]);

  const closePalette = useCallback(() => {
    onClose();
    if (activePaneId) {
      getTerminal(activePaneId)?.terminal.focus();
    }
  }, [activePaneId, onClose]);

  const runAction = useCallback(
    (command: string) => {
      if (command === "__split_vertical__") {
        splitActivePane("vertical");
      } else if (command === "__split_horizontal__") {
        splitActivePane("horizontal");
      } else if (command === "__close_pane__") {
        if (activePaneId) {
          closePane(activePaneId);
        }
      } else if (command === "__rename_session__") {
        onRenameRequest();
      } else if (command === "__settings__") {
        onSettingsRequest();
      } else if (command === "__voice_input__") {
        if (activePaneId) {
          void toggleVoiceInput(activePaneId);
        }
      } else if (command === "__export_diagnostic__") {
        void exportDiagnosticBundle();
      } else if (command.startsWith("/")) {
        sendAgentCommand(command);
      }

      closePalette();
    },
    [activePaneId, closePalette, closePane, onRenameRequest, onSettingsRequest, splitActivePane],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePalette();
        return;
      }

      if (dialogRef.current) {
        trapTabInside(event, dialogRef.current);
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) =>
          filtered.length === 0 ? 0 : (current + 1) % filtered.length,
        );
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) =>
          filtered.length === 0
            ? 0
            : (current - 1 + filtered.length) % filtered.length,
        );
        return;
      }

      if (event.key === "Enter" && filtered[selectedIndex]) {
        event.preventDefault();
        runAction(filtered[selectedIndex].command);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closePalette, filtered, open, runAction, selectedIndex]);

  if (!open) {
    return null;
  }

  return (
    <div className="command-palette-backdrop" onClick={closePalette}>
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Paleta de comandos"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="command-palette__input"
          placeholder="Digite um comando…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        <ul className="command-palette__list">
          {filtered.length === 0 && (
            <li className="command-palette__empty">Nenhum comando encontrado</li>
          )}
          {filtered.map((action, index) => (
            <li key={action.id}>
              <button
                type="button"
                className={
                  index === selectedIndex
                    ? "command-palette__item command-palette__item--selected"
                    : "command-palette__item"
                }
                onClick={() => runAction(action.command)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="command-palette__label">{action.label}</span>
                {action.shortcut && (
                  <span className="command-palette__shortcut">
                    {action.shortcut}
                  </span>
                )}
                {action.description && (
                  <span className="command-palette__description">
                    {action.description}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
