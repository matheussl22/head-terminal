import { COMMAND_PALETTE_SHORTCUT } from "../../config/toolbar";
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
  // Some conta a sessão ativa: se ela já mostra "Executando" abaixo, o
  // contador global só soma informação quando há MAIS sessões trabalhando.
  const showGlobalWorking = workingCount > (isWorking ? 1 : 0);

  return (
    <header className="agent-toolbar">
      <div className="agent-toolbar__brand">
        <span className="agent-toolbar__dot" aria-hidden />
        <span className="agent-toolbar__title">
          Head Terminal{import.meta.env.DEV ? " (Dev)" : ""}
        </span>
        {showGlobalWorking && (
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
