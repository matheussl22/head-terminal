import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { sendAgentCommand } from "../../actions/sendAgentCommand";
import { PALETTE_ACTIONS } from "../../config/toolbar";
import { exportDiagnosticBundle } from "../../core/export-diagnostic";
import { useSessionStore } from "../../core/session-manager";
import { toggleVoiceInput } from "../../core/voice-input";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onRenameRequest: () => void;
}

export function CommandPalette({
  open,
  onClose,
  onRenameRequest,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const splitActivePane = useSessionStore((state) => state.splitActivePane);
  const activePaneId = useSessionStore((state) => state.activePaneId);
  const closePane = useSessionStore((state) => state.closePane);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return PALETTE_ACTIONS;
    }

    return PALETTE_ACTIONS.filter(
      (action) =>
        action.label.toLowerCase().includes(normalized) ||
        action.command.toLowerCase().includes(normalized) ||
        action.description?.toLowerCase().includes(normalized),
    );
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

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
      } else if (command === "__voice_input__") {
        if (activePaneId) {
          void toggleVoiceInput(activePaneId);
        }
      } else if (command === "__export_diagnostic__") {
        void exportDiagnosticBundle();
      } else if (command.startsWith("/")) {
        sendAgentCommand(command);
      }

      onClose();
    },
    [activePaneId, closePane, onClose, onRenameRequest, splitActivePane],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
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
  }, [filtered, onClose, open, runAction, selectedIndex]);

  if (!open) {
    return null;
  }

  return (
    <div className="command-palette-backdrop" onClick={onClose}>
      <div
        className="command-palette"
        role="dialog"
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
