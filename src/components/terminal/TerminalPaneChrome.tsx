import { useEffect, useReducer } from "react";

import { ACTIVITY_LABEL } from "../../types/activity";
import { formatBranchLabel } from "../../core/git-context-utils";
import {
  paneSupervisor,
  useSupervisorStore,
} from "../../core/pane-supervisor";
import { useSessionStore } from "../../core/session-manager";
import { GitBranchBadge } from "../ui/GitBranchBadge";
import { IconClose } from "../ui/Icons";
import { VoiceInputButton } from "./VoiceInputButton";

interface TerminalPaneOverlayProps {
  paneId: string;
  paneIndex: number;
  paneCount: number;
}

function ReconnectCountdown({
  paneId,
  attempt,
  deadline,
}: {
  paneId: string;
  attempt: number;
  deadline: number;
}) {
  const [, tick] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, []);

  const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));

  return (
    <div className="terminal-overlay terminal-overlay--reconnect">
      <span>
        Reconectando em {remaining}s (tentativa {attempt}/5)
      </span>
      <div className="terminal-overlay__actions">
        <button
          type="button"
          className="terminal-overlay__action"
          onClick={() => paneSupervisor.restartNow(paneId)}
        >
          Agora
        </button>
        <button
          type="button"
          className="terminal-overlay__action terminal-overlay__action--ghost"
          onClick={() => paneSupervisor.cancel(paneId)}
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

export function TerminalPaneOverlay({ paneId }: TerminalPaneOverlayProps) {
  const activity = useSessionStore(
    (state) => state.paneRuntime[paneId]?.activity ?? "starting",
  );
  const status = useSessionStore(
    (state) => state.paneRuntime[paneId]?.status ?? "starting",
  );
  const supervisorState = useSupervisorStore(
    (state) => state.states[paneId] ?? null,
  );

  if (supervisorState?.kind === "countdown") {
    return (
      <ReconnectCountdown
        paneId={paneId}
        attempt={supervisorState.attempt}
        deadline={supervisorState.deadline}
      />
    );
  }

  if (supervisorState?.kind === "failed") {
    return (
      <div className="terminal-overlay terminal-overlay--error">
        <span>Reconexão falhou após {supervisorState.attempt} tentativas</span>
        <button
          type="button"
          className="terminal-overlay__action"
          onClick={() => paneSupervisor.restartNow(paneId)}
        >
          Reiniciar
        </button>
      </div>
    );
  }

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
          onClick={() => paneSupervisor.restartNow(paneId)}
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
  onClose: () => void;
}

export function TerminalPaneHeader({
  paneId,
  paneIndex,
  paneCount,
  isActive,
  onFocus,
  onClose,
}: TerminalPaneHeaderProps) {
  const activity = useSessionStore(
    (state) => state.paneRuntime[paneId]?.activity ?? "starting",
  );
  const restartPane = useSessionStore((state) => state.restartPane);
  const gitContext = useSessionStore((state) => state.paneGitContext[paneId]);
  const branchLabel = formatBranchLabel(gitContext);

  return (
    <div
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
      <span className="terminal-pane-header__right">
        <span className={`terminal-pane-header__status terminal-pane-header__status--${activity}`}>
          {ACTIVITY_LABEL[activity]}
        </span>
        {activity === "agent_fallback" && (
          <button
            type="button"
            className="terminal-pane-header__restart-agent"
            title="O agent caiu e um shell assumiu o terminal. Reiniciar o agent."
            onClick={(event) => {
              event.stopPropagation();
              restartPane(paneId);
            }}
          >
            Reiniciar agent
          </button>
        )}
        <VoiceInputButton paneId={paneId} />
        {paneCount > 1 && (
          <button
            type="button"
            className="terminal-pane-header__close"
            title="Fechar terminal"
            aria-label={`Fechar terminal ${paneIndex + 1}`}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            <IconClose />
          </button>
        )}
      </span>
    </div>
  );
}
