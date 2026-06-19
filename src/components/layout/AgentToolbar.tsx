import { clearAgentSession } from "../../actions/clearAgentSession";
import { sendAgentCommand } from "../../actions/sendAgentCommand";
import {
  AGENT_COMMANDS,
  CLEAR_SHORTCUT,
  COMMAND_PALETTE_SHORTCUT,
  HARD_CLEAR_SHORTCUT,
} from "../../config/toolbar";
import {
  getSessionActivity,
  getSessionActivityLabel,
} from "../../core/activity-utils";
import { useSessionStore } from "../../core/session-manager";
import { StatusDot } from "../ui/StatusDot";
import { Tooltip } from "../ui/Tooltip";

interface AgentToolbarProps {
  onOpenCommandPalette: () => void;
}

export function AgentToolbar({ onOpenCommandPalette }: AgentToolbarProps) {
  const splitActivePane = useSessionStore((state) => state.splitActivePane);
  const runEverything = useSessionStore((state) => state.runEverything);
  const setRunEverything = useSessionStore((state) => state.setRunEverything);
  const activeSession = useSessionStore((state) => state.getActiveSession());
  const paneActivities = useSessionStore((state) => state.paneActivities);

  const activity = activeSession
    ? getSessionActivity(activeSession, paneActivities)
    : "idle";
  const activityLabel = activeSession
    ? getSessionActivityLabel(activeSession, paneActivities)
    : null;
  const isWorking = activity === "working";

  return (
    <header className="agent-toolbar">
      <div className="agent-toolbar__brand">
        <span className="agent-toolbar__dot" aria-hidden />
        <span className="agent-toolbar__title">
          Head Terminal{import.meta.env.DEV ? " (Dev)" : ""}
        </span>
        {activityLabel && (
          <span className="agent-toolbar__session-status">
            <StatusDot activity={activity} />
            <span>{activityLabel}</span>
          </span>
        )}
      </div>

      <div className="agent-toolbar__actions">
        {AGENT_COMMANDS.map((action) => (
          <Tooltip
            key={action.id}
            content={
              action.id === "clear"
                ? `${action.description} (${CLEAR_SHORTCUT}). ${HARD_CLEAR_SHORTCUT} ou Shift+clique reinicia o PTY.`
                : (action.description ?? action.label)
            }
          >
            <button
              type="button"
              className={
                action.id === "clear"
                  ? "agent-toolbar__button"
                  : "agent-toolbar__button agent-toolbar__button--ghost"
              }
              disabled={action.id === "compact" && isWorking}
              onClick={(event) => {
                if (action.id === "clear" && event.shiftKey) {
                  clearAgentSession("hard");
                  return;
                }

                if (action.command.startsWith("/")) {
                  sendAgentCommand(action.command);
                }
              }}
            >
              {action.label}
            </button>
          </Tooltip>
        ))}

        <label
          className="agent-toolbar__toggle"
          title="Enviar comandos da toolbar para todos os terminais da sessão"
        >
          <input
            type="checkbox"
            checked={runEverything}
            onChange={(event) => setRunEverything(event.target.checked)}
          />
          <span>Run all</span>
        </label>

        <span className="agent-toolbar__divider" aria-hidden />

        <Tooltip content={`Paleta de comandos (${COMMAND_PALETTE_SHORTCUT})`}>
          <button
            type="button"
            className="agent-toolbar__button agent-toolbar__button--ghost"
            onClick={onOpenCommandPalette}
          >
            ⌘
          </button>
        </Tooltip>

        <Tooltip content="Dividir verticalmente (Ctrl+\\)">
          <button
            type="button"
            className="agent-toolbar__button agent-toolbar__button--ghost"
            onClick={() => splitActivePane("vertical")}
          >
            Split ↓
          </button>
        </Tooltip>

        <Tooltip content="Dividir horizontalmente (Ctrl+Shift+\\)">
          <button
            type="button"
            className="agent-toolbar__button agent-toolbar__button--ghost"
            onClick={() => splitActivePane("horizontal")}
          >
            Split →
          </button>
        </Tooltip>
      </div>
    </header>
  );
}
