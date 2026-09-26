import { COMMAND_PALETTE_SHORTCUT } from "../../config/toolbar";
import { revealPane } from "../../core/pane-minimize";
import type { PaneStatusTone } from "../../core/activity-display";
import { IconCommand, IconSettings } from "../ui/Icons";
import {
  findFirstPaneInTone,
  StatusDot,
  useTerminalStatusCounts,
} from "../ui/StatusDot";
import { Tooltip } from "../ui/Tooltip";

interface AgentToolbarProps {
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
}

/** Brings the first terminal in that state to the front — the way to answer
 * "who is waiting for me?" with ten terminals over five sessions. Out of the
 * dock or from behind a zoomed sibling too, keyboard included. */
function jumpToFirstPane(tone: PaneStatusTone): void {
  const target = findFirstPaneInTone(tone);
  if (target) {
    revealPane(target.paneId);
  }
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function AgentToolbar({
  onOpenCommandPalette,
  onOpenSettings,
}: AgentToolbarProps) {
  // Counts come as one string from the store, so activity ticks elsewhere
  // don't re-render the toolbar.
  const counts = useTerminalStatusCounts();

  return (
    <header className="agent-toolbar">
      <div className="agent-toolbar__brand">
        <span className="agent-toolbar__dot" aria-hidden />
        <span className="agent-toolbar__title">
          Head Terminal{import.meta.env.DEV ? " (Dev)" : ""}
        </span>
        {counts.waiting > 0 && (
          <button
            type="button"
            className="agent-toolbar__global-status status-count status-count--waiting"
            title={`${counts.waiting} ${plural(counts.waiting, "terminal espera", "terminais esperam")} sua resposta — clique para ir ao primeiro`}
            onClick={() => jumpToFirstPane("waiting")}
          >
            <StatusDot tone="waiting" title={null} />
            <span>{counts.waiting} aguardando</span>
          </button>
        )}
        {counts.done > 0 && (
          <button
            type="button"
            className="agent-toolbar__global-status status-count status-count--done"
            title={`${counts.done} ${plural(counts.done, "terminal terminou", "terminais terminaram")} enquanto você não estava olhando — clique para ir ao primeiro`}
            onClick={() => jumpToFirstPane("done")}
          >
            <StatusDot tone="done" title={null} />
            <span>
              {counts.done} {plural(counts.done, "concluído", "concluídos")}
            </span>
          </button>
        )}
        {counts.working > 0 && (
          <span
            className="agent-toolbar__global-status status-count status-count--working"
            title={`${counts.working} ${plural(counts.working, "terminal executando", "terminais executando")}`}
          >
            <StatusDot tone="working" title={null} />
            <span>{counts.working} executando</span>
          </span>
        )}
      </div>

      <div className="agent-toolbar__actions">
        <Tooltip content={`Paleta de comandos (${COMMAND_PALETTE_SHORTCUT})`} below>
          <button
            type="button"
            className="agent-toolbar__button agent-toolbar__button--ghost"
            aria-label="Paleta de comandos"
            onClick={onOpenCommandPalette}
          >
            <IconCommand />
            <span className="agent-toolbar__label">Comandos</span>
          </button>
        </Tooltip>

        <Tooltip content="Configurações" below>
          <button
            type="button"
            className="agent-toolbar__button agent-toolbar__button--ghost"
            aria-label="Configurações"
            onClick={onOpenSettings}
          >
            <IconSettings />
            <span className="agent-toolbar__label">Configurações</span>
          </button>
        </Tooltip>
      </div>
    </header>
  );
}
