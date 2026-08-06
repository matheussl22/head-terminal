import { useEffect, useReducer, type ComponentType } from "react";

import { ACTIVITY_LABEL } from "../../types/activity";
import { contextColor } from "../../core/context-meter";
import { formatBranchLabel } from "../../core/git-context-utils";
import {
  paneSupervisor,
  useSupervisorStore,
} from "../../core/pane-supervisor";
import { useSessionStore } from "../../core/session-manager";
import { GitBranchBadge } from "../ui/GitBranchBadge";
import {
  IconActivity,
  IconAgentClaude,
  IconAgentCodex,
  IconAgentCursor,
  IconAgentShell,
  IconClose,
  IconRefresh,
} from "../ui/Icons";
import { StatusDot } from "../ui/StatusDot";
import { ResumeSessionMenu } from "./ResumeSessionMenu";
import { VoiceInputButton } from "./VoiceInputButton";

const AGENT_ICON: Record<string, ComponentType<{ size?: number }>> = {
  antigravity: IconActivity,
  cursor: IconAgentCursor,
  claude: IconAgentClaude,
  codex: IconAgentCodex,
  shell: IconAgentShell,
};

const AGENT_LABEL: Record<string, string> = {
  antigravity: "agy",
  cursor: "cx",
  claude: "cc",
  codex: "cdx",
  shell: "sh",
};

function AgentIcon({
  agentProfileId,
  size = 14,
}: {
  agentProfileId: string;
  size?: number;
}) {
  const Icon = AGENT_ICON[agentProfileId] ?? IconAgentShell;
  return <Icon size={size} />;
}

function paneShortLabel(agentProfileId: string, paneIndex: number): string {
  const prefix = AGENT_LABEL[agentProfileId] ?? agentProfileId.slice(0, 3);
  return `${prefix}${paneIndex + 1}`;
}

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
        <span>
          {supervisorState.attempt > 0
            ? `Reconexão falhou após ${supervisorState.attempt} tentativas`
            : activity === "error"
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

  if (activity === "starting" && status === "starting") {
    return (
      <div className="terminal-overlay terminal-overlay--starting">
        <span className="terminal-overlay__spinner" aria-hidden />
        <span>Conectando ao agent…</span>
      </div>
    );
  }

  // Only block the pane when the PTY actually died. Text that looks like an
  // error while the process is still running must not cover the terminal.
  if (status === "exited") {
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
  cwd: string;
  agentProfileId: string;
  claudeAccountId?: string;
  paneIndex: number;
  paneCount: number;
  isActive: boolean;
  onFocus: () => void;
  onClose: () => void;
}

export function TerminalPaneHeader({
  paneId,
  cwd,
  agentProfileId,
  claudeAccountId,
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
  const contextPercent = useSessionStore(
    (state) => state.paneRuntime[paneId]?.contextPercent,
  );
  const branchLabel = formatBranchLabel(gitContext);
  const shortLabel = paneShortLabel(agentProfileId, paneIndex);

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
        <span
          className={`terminal-pane-header__agent terminal-pane-header__agent--${agentProfileId}`}
          title={agentProfileId}
        >
          <AgentIcon agentProfileId={agentProfileId} size={13} />
        </span>
        <span className="terminal-pane-header__name">{shortLabel}</span>
        <StatusDot activity={activity} />
        {branchLabel && (
          <span className="terminal-pane-header__branch" title={branchLabel}>
            <GitBranchBadge
              context={gitContext}
              className="terminal-pane-header__branch-badge"
            />
          </span>
        )}
      </span>
      <span className="terminal-pane-header__right">
        {contextPercent !== undefined && (
          <span
            className={
              contextPercent < 25
                ? "terminal-pane-header__context terminal-pane-header__context--critical"
                : "terminal-pane-header__context"
            }
            style={{ color: contextColor(contextPercent) }}
            title={`Contexto restante do agent: ${contextPercent}%`}
          >
            ctx {contextPercent}%
          </span>
        )}
        <span
          className={`terminal-pane-header__status terminal-pane-header__status--${activity}`}
        >
          {ACTIVITY_LABEL[activity]}
        </span>
        {activity === "agent_fallback" && (
          <button
            type="button"
            className="terminal-pane-header__restart-agent"
            title="Nova conversa. Segure Shift para continuar a anterior."
            onClick={(event) => {
              event.stopPropagation();
              restartPane(paneId, {
                continueConversation: event.shiftKey,
              });
            }}
          >
            Reiniciar agent
          </button>
        )}
        <VoiceInputButton paneId={paneId} />
        <ResumeSessionMenu
          paneId={paneId}
          agentProfileId={agentProfileId}
          cwd={cwd}
          claudeAccountId={claudeAccountId}
        />
        <button
          type="button"
          className="terminal-pane-header__action"
          title="Reiniciar pane (Shift: continuar conversa)"
          aria-label={`Reiniciar ${shortLabel}`}
          onClick={(event) => {
            event.stopPropagation();
            restartPane(paneId, {
              continueConversation: event.shiftKey,
            });
          }}
        >
          <IconRefresh size={13} />
        </button>
        {paneCount > 1 && (
          <button
            type="button"
            className="terminal-pane-header__action terminal-pane-header__close"
            title="Fechar terminal"
            aria-label={`Fechar ${shortLabel}`}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            <IconClose size={13} />
          </button>
        )}
      </span>
    </div>
  );
}
