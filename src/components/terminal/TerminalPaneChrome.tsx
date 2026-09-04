import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type ComponentType,
} from "react";

import { ACTIVITY_LABEL } from "../../types/activity";
import { contextColor } from "../../core/context-meter";
import { formatBranchLabel } from "../../core/git-context-utils";
import {
  paneSupervisor,
  useSupervisorStore,
} from "../../core/pane-supervisor";
import {
  CONVERSATION_LABEL_MAX_LENGTH,
  useSessionStore,
} from "../../core/session-manager";
import { NEW_CONVERSATION_LABEL } from "../../core/conversation-display";
import { basenamePath } from "../../core/path-utils";
import { usePaneConversation } from "../../hooks/usePaneConversation";
import { GitBranchBadge } from "../ui/GitBranchBadge";
import {
  IconActivity,
  IconAgentClaude,
  IconAgentCodex,
  IconAgentOllama,
  IconAgentOrnith,
  IconAgentQwen,
  IconAgentCursor,
  IconAgentShell,
  IconClose,
  IconPencil,
  IconFolder,
  IconRefresh,
  IconSplitHorizontal,
  IconSplitVertical,
} from "../ui/Icons";
import { ResumeSessionMenu } from "./ResumeSessionMenu";
import { VoiceInputButton } from "./VoiceInputButton";

const AGENT_ICON: Record<string, ComponentType<{ size?: number }>> = {
  antigravity: IconActivity,
  cursor: IconAgentCursor,
  claude: IconAgentClaude,
  codex: IconAgentCodex,
  ollama: IconAgentOllama,
  ornith: IconAgentOrnith,
  qwen27: IconAgentQwen,
  shell: IconAgentShell,
};

const AGENT_LABEL: Record<string, string> = {
  antigravity: "agy",
  cursor: "cx",
  claude: "cc",
  codex: "cdx",
  ollama: "olm",
  ornith: "orn",
  qwen27: "qw",
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
        <div className="terminal-overlay__actions">
          <button
            type="button"
            className="terminal-overlay__action"
            onClick={() => paneSupervisor.restartNow(paneId)}
          >
            Reiniciar
          </button>
        </div>
      </div>
    );
  }

  // Starting uses the header status chip spinner — never cover the PTY.
  // Only show a bar when the PTY actually died so crash output stays visible.
  if (status === "exited") {
    return (
      <div className="terminal-overlay terminal-overlay--error">
        <span>
          {activity === "error"
            ? "O terminal encontrou um erro"
            : "Processo encerrado"}
        </span>
        <div className="terminal-overlay__actions">
          <button
            type="button"
            className="terminal-overlay__action"
            onClick={() => paneSupervisor.restartNow(paneId)}
          >
            Reiniciar
          </button>
        </div>
      </div>
    );
  }

  return null;
}

/** Name of the agent conversation the pane is on, with inline rename. Shows
 * "nova conversa" until the CLI writes its transcript and the pane anchors
 * onto it — renaming before that still works, the name is applied as soon as
 * the conversation is identified. */
function PaneConversationName({
  paneId,
  cwd,
  agentProfileId,
  claudeAccountId,
}: {
  paneId: string;
  cwd: string;
  agentProfileId: string;
  claudeAccountId?: string;
}) {
  const conversation = usePaneConversation({
    paneId,
    cwd,
    agentProfileId,
    claudeAccountId,
  });
  const setPaneConversationLabel = useSessionStore(
    (state) => state.setPaneConversationLabel,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  if (!conversation.supported) {
    return null;
  }

  const displayName = conversation.name ?? NEW_CONVERSATION_LABEL;
  const modifier = conversation.isCustom
    ? " terminal-pane-header__conversation--named"
    : conversation.name
      ? ""
      : " terminal-pane-header__conversation--empty";

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        className="terminal-pane-header__conversation-input"
        value={draft}
        maxLength={CONVERSATION_LABEL_MAX_LENGTH}
        placeholder="Nome da conversa"
        onChange={(event) => setDraft(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onBlur={() => {
          setPaneConversationLabel(paneId, draft);
          setIsEditing(false);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            setPaneConversationLabel(paneId, draft);
            setIsEditing(false);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setIsEditing(false);
          }
        }}
      />
    );
  }

  return (
    <>
      <span className="terminal-pane-header__sep" aria-hidden>
        ·
      </span>
      <button
        type="button"
        className={`terminal-pane-header__conversation${modifier}`}
        title={`Conversa: ${displayName} — clique para renomear (vazio volta ao nome automático)`}
        onClick={(event) => {
          event.stopPropagation();
          setDraft(conversation.name ?? "");
          setIsEditing(true);
        }}
      >
        <span className="terminal-pane-header__conversation-text">
          {displayName}
        </span>
        <IconPencil
          size={11}
          className="terminal-pane-header__conversation-pencil"
        />
      </button>
    </>
  );
}

/** The folder this terminal runs in. Picking another one restarts the pane
 * there — a conversation belongs to a folder — without touching its siblings. */
function PaneFolderButton({ paneId, cwd }: { paneId: string; cwd: string }) {
  const updatePaneCwd = useSessionStore((state) => state.updatePaneCwd);

  return (
    <button
      type="button"
      className="terminal-pane-header__cwd"
      title={`Pasta: ${cwd} — clique para trocar (reinicia só este terminal)`}
      aria-label={`Pasta do terminal: ${cwd}`}
      onClick={(event) => {
        event.stopPropagation();
        void window.headTerminal.system
          .selectDirectory(cwd)
          .then((selected) => {
            if (typeof selected === "string" && selected) {
              updatePaneCwd(paneId, selected);
            }
          })
          .catch(() => undefined);
      }}
    >
      <IconFolder size={11} className="terminal-pane-header__cwd-icon" />
      <span className="terminal-pane-header__cwd-text">{basenamePath(cwd, cwd)}</span>
    </button>
  );
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
  const splitPane = useSessionStore((state) => state.splitPane);
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
        <PaneFolderButton paneId={paneId} cwd={cwd} />
        {branchLabel && (
          <span className="terminal-pane-header__branch" title={branchLabel}>
            <GitBranchBadge
              context={gitContext}
              className="terminal-pane-header__branch-badge"
            />
          </span>
        )}
        <PaneConversationName
          paneId={paneId}
          cwd={cwd}
          agentProfileId={agentProfileId}
          claudeAccountId={claudeAccountId}
        />
        <ResumeSessionMenu
          paneId={paneId}
          agentProfileId={agentProfileId}
          cwd={cwd}
          claudeAccountId={claudeAccountId}
        />
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
          title={
            activity === "agent_fallback"
              ? "Agent caiu — shell ativo"
              : ACTIVITY_LABEL[activity]
          }
        >
          {ACTIVITY_LABEL[activity]}
        </span>
        {activity === "agent_fallback" && (
          <button
            type="button"
            className="terminal-pane-header__restart-agent"
            title="Agent caiu — shell ativo. Nova conversa. Segure Shift para continuar a anterior."
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
        <button
          type="button"
          className="terminal-pane-header__action"
          title="Dividir abaixo (Ctrl+\)"
          aria-label="Dividir verticalmente"
          onClick={(event) => {
            event.stopPropagation();
            onFocus();
            splitPane(paneId, "vertical");
          }}
        >
          <IconSplitVertical size={13} />
        </button>
        <button
          type="button"
          className="terminal-pane-header__action"
          title="Dividir ao lado (Ctrl+Shift+\)"
          aria-label="Dividir horizontalmente"
          onClick={(event) => {
            event.stopPropagation();
            onFocus();
            splitPane(paneId, "horizontal");
          }}
        >
          <IconSplitHorizontal size={13} />
        </button>
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
