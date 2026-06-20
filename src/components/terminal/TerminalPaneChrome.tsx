import { ACTIVITY_LABEL, type PaneActivity } from "../../types/activity";
import { formatBranchLabel } from "../../core/git-context-utils";
import { useSessionStore } from "../../core/session-manager";
import { GitBranchBadge } from "../ui/GitBranchBadge";

interface TerminalPaneOverlayProps {
  paneId: string;
  paneIndex: number;
  paneCount: number;
}

export function TerminalPaneOverlay({ paneId }: TerminalPaneOverlayProps) {
  const activity = useSessionStore(
    (state) => state.paneActivities[paneId] ?? "starting",
  );
  const status = useSessionStore((state) => {
    for (const session of state.sessions) {
      if (paneId in session.paneStatuses) {
        return session.paneStatuses[paneId];
      }
    }
    return "starting";
  });
  const restartPane = useSessionStore((state) => state.restartPane);

  if (activity === "starting" && status === "starting") {
    return (
      <div className="terminal-overlay terminal-overlay--starting">
        <span className="terminal-overlay__spinner" aria-hidden />
        <span>Conectando ao agent…</span>
      </div>
    );
  }

  if (activity === "error" || status === "exited") {
    return (
      <div className="terminal-overlay terminal-overlay--error">
        <span>
          {activity === "error"
            ? "O terminal encontrou um erro"
            : "Processo encerrado"}
        </span>
        <button
          type="button"
          className="terminal-overlay__action"
          onClick={() => restartPane(paneId)}
        >
          Reiniciar
        </button>
      </div>
    );
  }

  return null;
}

interface TerminalPaneHeaderProps {
  paneId: string;
  paneIndex: number;
  paneCount: number;
  isActive: boolean;
  onFocus: () => void;
}

export function TerminalPaneHeader({
  paneId,
  paneIndex,
  paneCount,
  isActive,
  onFocus,
}: TerminalPaneHeaderProps) {
  const activity = useSessionStore(
    (state) => state.paneActivities[paneId] ?? "starting",
  );
  const gitContext = useSessionStore((state) => state.paneGitContext[paneId]);
  const branchLabel = formatBranchLabel(gitContext);

  return (
    <button
      type="button"
      className={
        isActive
          ? "terminal-pane-header terminal-pane-header--active"
          : "terminal-pane-header"
      }
      onClick={onFocus}
    >
      <span className="terminal-pane-header__title">
        <span>
          Terminal {paneIndex + 1}
          {paneCount > 1 ? `/${paneCount}` : ""}
        </span>
        {branchLabel && (
          <>
            <span className="terminal-pane-header__sep" aria-hidden>
              ·
            </span>
            <GitBranchBadge
              context={gitContext}
              className="terminal-pane-header__branch"
            />
          </>
        )}
      </span>
      <span className={`terminal-pane-header__status terminal-pane-header__status--${activity}`}>
        {ACTIVITY_LABEL[activity]}
      </span>
    </button>
  );
}

export function getPaneActivity(
  paneId: string,
  paneActivities: Record<string, PaneActivity>,
): PaneActivity {
  return paneActivities[paneId] ?? "starting";
}
