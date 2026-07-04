import { clearAgentSession } from "../../actions/clearAgentSession";
import { sendAgentCommand } from "../../actions/sendAgentCommand";
import {
  AGENT_COMMANDS,
  CLEAR_SHORTCUT,
  COMMAND_PALETTE_SHORTCUT,
  HARD_CLEAR_SHORTCUT,
} from "../../config/toolbar";
import {
  countWorkingSessions,
  getSessionActivity,
  getSessionActivityLabel,
} from "../../core/activity-utils";
import { useSessionStore } from "../../core/session-manager";
import {
  IconCommand,
  IconSettings,
  IconSplitHorizontal,
  IconSplitVertical,
} from "../ui/Icons";
import { StatusDot } from "../ui/StatusDot";
import { Tooltip } from "../ui/Tooltip";

interface AgentToolbarProps {
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
}

export function AgentToolbar({
  onOpenCommandPalette,
  onOpenSettings,
}: AgentToolbarProps) {
  const splitActivePane = useSessionStore((state) => state.splitActivePane);
  const runEverything = useSessionStore((state) => state.runEverything);
  const setRunEverything = useSessionStore((state) => state.setRunEverything);
  // Narrow selectors: all primitives, so activity ticks elsewhere in the
  // store don't re-render the toolbar.
  const activity = useSessionStore((state) => {
    const session =
      state.sessions.find((item) => item.id === state.activeSessionId) ?? null;
    return session ? getSessionActivity(session, state.paneRuntime) : "idle";
  });
  const activityLabel = useSessionStore((state) => {
    const session =
      state.sessions.find((item) => item.id === state.activeSessionId) ?? null;
    return session
      ? getSessionActivityLabel(session, state.paneRuntime)
      : null;
  });
  const workingCount = useSessionStore((state) =>
    countWorkingSessions(state.sessions, state.paneRuntime),
  );
  const isWorking = activity === "working";

  return (
    <header className="agent-toolbar">
      <div className="agent-toolbar__brand">
        <span className="agent-toolbar__dot" aria-hidden />
        <span className="agent-toolbar__title">
          Head Terminal{import.meta.env.DEV ? " (Dev)" : ""}
        </span>
        {workingCount > 0 && (
          <span className="agent-toolbar__global-status">
            <StatusDot activity="working" />
            <span>
              {workingCount} executando
            </span>
          </span>
        )}
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
                  ? "agent-toolbar__button agent-toolbar__button--primary"
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

        <Tooltip content="Dividir verticalmente (Ctrl+\\)">
          <button
            type="button"
            className="agent-toolbar__button agent-toolbar__button--ghost agent-toolbar__button--icon"
            aria-label="Dividir verticalmente"
            onClick={() => splitActivePane("vertical")}
          >
            <IconSplitVertical />
          </button>
        </Tooltip>

        <Tooltip content="Dividir horizontalmente (Ctrl+Shift+\\)">
          <button
            type="button"
            className="agent-toolbar__button agent-toolbar__button--ghost agent-toolbar__button--icon"
            aria-label="Dividir horizontalmente"
            onClick={() => splitActivePane("horizontal")}
          >
            <IconSplitHorizontal />
          </button>
        </Tooltip>

        <Tooltip content={`Paleta de comandos (${COMMAND_PALETTE_SHORTCUT})`}>
          <button
            type="button"
            className="agent-toolbar__button agent-toolbar__button--ghost agent-toolbar__button--icon"
            aria-label="Paleta de comandos"
            onClick={onOpenCommandPalette}
          >
            <IconCommand />
          </button>
        </Tooltip>

        <Tooltip content="Configurações">
          <button
            type="button"
            className="agent-toolbar__button agent-toolbar__button--ghost agent-toolbar__button--icon"
            aria-label="Configurações"
            onClick={onOpenSettings}
          >
            <IconSettings />
          </button>
        </Tooltip>
      </div>
    </header>
  );
}
