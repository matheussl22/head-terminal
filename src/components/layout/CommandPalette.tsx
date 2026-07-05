import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { sendAgentCommand } from "../../actions/sendAgentCommand";
import { PALETTE_ACTIONS } from "../../config/toolbar";
import { formatAgentInstructionMention } from "../../core/agent-instructions";
import { exportDiagnosticBundle } from "../../core/export-diagnostic";
import { pickGitContextForSession } from "../../core/git-context-utils";
import { collectPaneIds } from "../../core/session-layout";
import { useSessionStore } from "../../core/session-manager";
import { toggleVoiceInput } from "../../core/voice-input";
import { useAgentInstructionFile } from "../../hooks/useAgentInstructionFile";

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
  const splitActivePane = useSessionStore((state) => state.splitActivePane);
  const activePaneId = useSessionStore((state) => state.activePaneId);
  const closePane = useSessionStore((state) => state.closePane);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const sessions = useSessionStore((state) => state.sessions);
  const paneGitContext = useSessionStore((state) => state.paneGitContext);
  const sessionGitContext = useSessionStore((state) => state.sessionGitContext);

  const activeSession = sessions.find((item) => item.id === activeSessionId);
  const activePaneIds = activeSession
    ? collectPaneIds(activeSession.layout)
    : [];
  const activeGitContext = activeSession
    ? pickGitContextForSession(
        activeSession.id,
        activePaneIds,
        paneGitContext,
        sessionGitContext,
        {
          activePaneId,
          isActiveSession: true,
        },
      )
    : undefined;
  const instructionFile = useAgentInstructionFile(activeGitContext?.repoRoot);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const actions = PALETTE_ACTIONS.filter((action) => {
      if (action.id === "agent-instructions" && !instructionFile) {
        return false;
      }
      return true;
    });

    if (!normalized) {
      return actions;
    }

    return actions.filter(
      (action) =>
        action.label.toLowerCase().includes(normalized) ||
        action.command.toLowerCase().includes(normalized) ||
        action.description?.toLowerCase().includes(normalized),
    );
  }, [instructionFile, query]);

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
      } else if (command === "__settings__") {
        onSettingsRequest();
      } else if (command === "__voice_input__") {
        if (activePaneId) {
          void toggleVoiceInput(activePaneId);
        }
      } else if (command === "__export_diagnostic__") {
        void exportDiagnosticBundle();
      } else if (command === "__agent_instructions__") {
        if (instructionFile) {
          sendAgentCommand(formatAgentInstructionMention(instructionFile));
        }
      } else if (command.startsWith("/")) {
        sendAgentCommand(command);
      }

      onClose();
    },
    [activePaneId, closePane, instructionFile, onClose, onRenameRequest, onSettingsRequest, splitActivePane],
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
