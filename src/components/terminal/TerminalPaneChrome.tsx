import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentType,
} from "react";

import { VOICE_SHORTCUT } from "../../config/toolbar";
import {
  describePaneStatus,
  formatStatusDetail,
  type PaneStatusView,
} from "../../core/activity-display";
import { isResumableAgent } from "../../core/agent-sessions-bridge";
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
import {
  collectPaneIds,
  findPaneNode,
  isLayoutEqualized,
} from "../../core/session-layout";
import { paneShortLabel } from "../../core/pane-labels";
import { minimizePaneWithMotion } from "../../core/pane-minimize";
import { basenamePath } from "../../core/path-utils";
import { formatShortcut } from "../../core/shortcuts";
import {
  isVoiceInputBlocked,
  isVoiceInputSupported,
  toggleVoiceInput,
} from "../../core/voice-input";
import { isolatePaneInWorktree } from "../../core/worktree";
import {
  usePaneConversation,
  type PaneConversation,
} from "../../hooks/usePaneConversation";
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
  IconEqualize,
  IconFolder,
  IconFolderOpen,
  IconGitBranch,
  IconHistory,
  IconMaximize,
  IconMic,
  IconMinimize,
  IconMinimizeToDock,
  IconPencil,
  IconRefresh,
  IconRestartContinue,
  IconSplitHorizontal,
  IconSplitVertical,
} from "../ui/Icons";
import { StatusDot } from "../ui/StatusDot";
import { PaneActionsMenu, type PaneMenuAction } from "./PaneActionsMenu";
import {
  ResumeSessionMenu,
  type ResumeSessionMenuHandle,
} from "./ResumeSessionMenu";
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

export function AgentIcon({
  agentProfileId,
  size = 14,
}: {
  agentProfileId: string;
  size?: number;
}) {
  const Icon = AGENT_ICON[agentProfileId] ?? IconAgentShell;
  return <Icon size={size} />;
}

// One source for "cc3" — the header, its minimized card and the
// notifications all name a pane the same way.
export { paneShortLabel };

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
 * the conversation is identified. The header owns `editing` and the
 * conversation lookup, so the "⋯" menu can start a rename, and the tooltip
 * and the menu can name the conversation, while the name itself has no room
 * on screen. */
function PaneConversationName({
  paneId,
  conversation,
  editing,
  onEditingChange,
}: {
  paneId: string;
  conversation: PaneConversation;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const setPaneConversationLabel = useSessionStore(
    (state) => state.setPaneConversationLabel,
  );
  const [draft, setDraft] = useState("");
  const [wasEditing, setWasEditing] = useState(editing);
  const inputRef = useRef<HTMLInputElement>(null);

  // Entering edit mode — from a click here or from the menu — starts from
  // the name on screen.
  if (editing !== wasEditing) {
    setWasEditing(editing);
    if (editing) {
      setDraft(conversation.name ?? "");
    }
  }

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (!conversation.supported) {
    return null;
  }

  const displayName = conversation.name ?? NEW_CONVERSATION_LABEL;
  const modifier = conversation.isCustom
    ? " terminal-pane-header__conversation--named"
    : conversation.name
      ? ""
      : " terminal-pane-header__conversation--empty";

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="terminal-pane-header__conversation-input"
        value={draft}
        maxLength={CONVERSATION_LABEL_MAX_LENGTH}
        placeholder="Nome da conversa"
        aria-label="Nome da conversa"
        onChange={(event) => setDraft(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onBlur={() => {
          setPaneConversationLabel(paneId, draft);
          onEditingChange(false);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            setPaneConversationLabel(paneId, draft);
            onEditingChange(false);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onEditingChange(false);
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
          onEditingChange(true);
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

/** Picks another folder for this terminal. It restarts there — a
 * conversation belongs to a folder — without touching its siblings. */
function pickPaneFolder(paneId: string, cwd: string): void {
  void window.headTerminal.system
    .selectDirectory(cwd)
    .then((selected) => {
      if (typeof selected === "string" && selected) {
        useSessionStore.getState().updatePaneCwd(paneId, selected);
      }
    })
    .catch(() => undefined);
}

/** The folder this terminal runs in. */
function PaneFolderButton({ paneId, cwd }: { paneId: string; cwd: string }) {
  return (
    <button
      type="button"
      className="terminal-pane-header__cwd"
      title={`Pasta: ${cwd} — clique para trocar (reinicia só este terminal)`}
      aria-label={`Pasta do terminal: ${cwd}`}
      onClick={(event) => {
        event.stopPropagation();
        pickPaneFolder(paneId, cwd);
      }}
    >
      <IconFolder size={11} className="terminal-pane-header__cwd-icon" />
      <span className="terminal-pane-header__cwd-text">{basenamePath(cwd, cwd)}</span>
    </button>
  );
}

function isElementShown(element: HTMLElement | null | undefined): boolean {
  if (!element) {
    return false;
  }
  return typeof element.checkVisibility === "function"
    ? element.checkVisibility()
    : element.offsetParent !== null;
}

/** Status chip: the tone's glyph plus its word. In a narrow pane the word is
 * kept only for what asks for the user (waiting, done, error, agent down);
 * the rest shrink to the glyph, whose shape still tells them apart. The word
 * stays in the DOM for screen readers either way. */
function PaneStatusChip({
  view,
  tooltip,
}: {
  view: PaneStatusView;
  tooltip: () => string;
}) {
  return (
    <span
      className={
        `terminal-pane-header__status terminal-pane-header__status--${view.tone}` +
        (view.attention ? " terminal-pane-header__status--attention" : "")
      }
      title={formatStatusDetail(view)}
      // The time in the tooltip ("há 2 min") is computed when the pointer
      // arrives rather than by a timer: ten panes don't re-render every
      // second for a tooltip nobody is reading.
      onPointerEnter={(event) => {
        event.currentTarget.title = tooltip();
      }}
    >
      <StatusDot tone={view.tone} title={null} />
      <span className="terminal-pane-header__status-label">{view.label}</span>
    </span>
  );
}

interface TerminalPaneHeaderProps {
  paneId: string;
  sessionId: string;
  cwd: string;
  agentProfileId: string;
  claudeAccountId?: string;
  paneIndex: number;
  paneCount: number;
  onScreenPaneCount: number;
  isActive: boolean;
  isMaximized: boolean;
  /** This pane is on screen (see ResumeSessionMenu's `onScreen`). */
  onScreen?: boolean;
  onFocus: () => void;
  onClose: () => void;
}

/**
 * Every control is rendered, always; the header's container queries
 * (panes.css) decide what fits at the pane's width, and the "⋯" menu lists
 * whatever they hid. Nothing here measures the pane, so dragging a divider
 * re-renders nothing.
 */
export function TerminalPaneHeader({
  paneId,
  sessionId,
  cwd,
  agentProfileId,
  claudeAccountId,
  paneIndex,
  paneCount,
  onScreenPaneCount,
  isActive,
  isMaximized,
  onScreen = true,
  onFocus,
  onClose,
}: TerminalPaneHeaderProps) {
  const runtime = useSessionStore((state) => state.paneRuntime[paneId]);
  const view = useMemo(() => describePaneStatus(runtime), [runtime]);
  const contextPercent = runtime?.contextPercent;
  const restartPane = useSessionStore((state) => state.restartPane);
  const splitPane = useSessionStore((state) => state.splitPane);
  const toggleMaximizedPane = useSessionStore(
    (state) => state.toggleMaximizedPane,
  );
  const equalizeSessionLayout = useSessionStore(
    (state) => state.equalizeSessionLayout,
  );
  const gitContext = useSessionStore((state) => state.paneGitContext[paneId]);
  // Este terminal já tem uma árvore só dele: ou a pegou sozinho, ou é o único
  // da sessão e a sessão inteira foi isolada. Dois terminais numa sessão
  // isolada ainda dividem a mesma árvore, então lá o botão continua valendo.
  const ownsWorktree = useSessionStore((state) =>
    state.sessions.some((session) => {
      const pane = findPaneNode(session.layout, paneId);
      if (!pane) {
        return false;
      }
      return (
        Boolean(pane.worktree) ||
        (Boolean(session.worktree) && collectPaneIds(session.layout).length === 1)
      );
    }),
  );
  const conversation = usePaneConversation({
    paneId,
    cwd,
    agentProfileId,
    claudeAccountId,
  });
  // Where the rename started: from the "⋯" the field takes the folder and
  // branch's room (a narrow pane has none to spare); a click on the name in a
  // wide pane edits it in place and leaves the rest of the header alone.
  const [renaming, setRenaming] = useState<false | "inline" | "menu">(false);
  const [isolating, setIsolating] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const resumeMenuRef = useRef<ResumeSessionMenuHandle>(null);

  const branchLabel = formatBranchLabel(gitContext);
  const shortLabel = paneShortLabel(agentProfileId, paneIndex);
  const folderName = basenamePath(cwd, cwd);
  const resumable = isResumableAgent(agentProfileId);
  const canIsolate = Boolean(gitContext?.repoRoot) && !ownsWorktree;
  const canMaximize = onScreenPaneCount > 1 || isMaximized;
  const canClose = paneCount > 1;

  const toggleMaximized = () => {
    onFocus();
    toggleMaximizedPane(paneId);
  };
  const split = (direction: "vertical" | "horizontal") => {
    onFocus();
    splitPane(paneId, direction);
  };
  const isolate = () => {
    setIsolating(true);
    void isolatePaneInWorktree(paneId).finally(() => setIsolating(false));
  };

  const conversationName = conversation.name ?? NEW_CONVERSATION_LABEL;
  /** The name has no room below the narrowest tiers (panes.css); the tooltip
   * and the "⋯" header name the conversation then. */
  const isConversationHidden = () =>
    conversation.supported &&
    !isElementShown(
      headerRef.current?.querySelector<HTMLElement>(".terminal-pane-header__conversation"),
    );

  /** Status tooltip, plus whatever the header had no room to show. */
  const statusTooltip = () => {
    const header = headerRef.current;
    const lines = [`${shortLabel} · ${formatStatusDetail(view, Date.now())}`];
    if (isConversationHidden()) {
      lines.push(`Conversa: ${conversationName}`);
    }
    if (!isElementShown(header?.querySelector<HTMLElement>(".terminal-pane-header__cwd"))) {
      lines.push(`Pasta: ${cwd}`);
    }
    if (
      branchLabel &&
      !isElementShown(header?.querySelector<HTMLElement>(".terminal-pane-header__branch"))
    ) {
      lines.push(`Branch: ${branchLabel}`);
    }
    if (
      contextPercent !== undefined &&
      !isElementShown(header?.querySelector<HTMLElement>(".terminal-pane-header__context"))
    ) {
      lines.push(`Contexto restante: ${contextPercent}%`);
    }
    return lines.join("\n");
  };

  const menuActions: PaneMenuAction[] = [];
  if (resumable) {
    menuActions.push(
      {
        id: "history",
        label: "Histórico de conversas…",
        icon: IconHistory,
        group: "conversation",
        keepFocus: true,
        run: (anchor) => resumeMenuRef.current?.openAt(anchor),
      },
      {
        id: "rename",
        label: "Renomear conversa",
        icon: IconPencil,
        group: "conversation",
        keepFocus: true,
        run: () => setRenaming("menu"),
      },
    );
  }
  menuActions.push({
    id: "folder",
    label: "Trocar pasta…",
    hint: "reinicia só este terminal",
    icon: IconFolderOpen,
    group: "conversation",
    run: () => pickPaneFolder(paneId, cwd),
  });
  if (canMaximize) {
    menuActions.push({
      id: "maximize",
      label: isMaximized ? "Restaurar os outros terminais" : "Expandir este terminal",
      icon: isMaximized ? IconMinimize : IconMaximize,
      shortcut: "Ctrl+Shift+Z",
      inline: "maximize",
      group: "layout",
      run: toggleMaximized,
    });
  }
  menuActions.push(
    {
      id: "split-v",
      label: "Dividir abaixo",
      icon: IconSplitVertical,
      shortcut: "Ctrl+\\",
      inline: "split-v",
      group: "layout",
      run: () => split("vertical"),
    },
    {
      id: "split-h",
      label: "Dividir ao lado",
      icon: IconSplitHorizontal,
      shortcut: "Ctrl+Shift+\\",
      inline: "split-h",
      group: "layout",
      run: () => split("horizontal"),
    },
  );
  if (paneCount >= 3) {
    menuActions.push({
      id: "equalize",
      label: "Distribuir terminais igualmente",
      icon: IconEqualize,
      group: "layout",
      disabledHint: "já estão com o mesmo tamanho",
      disabled: () => {
        const state = useSessionStore.getState();
        const session = state.sessions.find((candidate) => candidate.id === sessionId);
        if (!session) {
          return true;
        }
        const hidden = new Set(
          collectPaneIds(session.layout).filter((id) => state.minimizedPanes[id]),
        );
        return isLayoutEqualized(session.layout, hidden);
      },
      run: () => equalizeSessionLayout(sessionId),
    });
  }
  if (canIsolate) {
    menuActions.push({
      id: "isolate",
      label: "Isolar em worktree",
      hint: "branch própria em pasta irmã; reinicia só este terminal",
      icon: IconGitBranch,
      inline: "isolate",
      group: "layout",
      disabled: isolating,
      run: isolate,
    });
  }
  if (isVoiceInputSupported()) {
    menuActions.push({
      id: "voice",
      label: "Gravar prompt por voz",
      icon: IconMic,
      shortcut: VOICE_SHORTCUT,
      inline: "voice",
      group: "process",
      disabled: () => isVoiceInputBlocked(paneId),
      run: () => void toggleVoiceInput(paneId),
    });
  }
  menuActions.push({
    id: "restart",
    label: resumable ? "Reiniciar com nova conversa" : "Reiniciar terminal",
    icon: IconRefresh,
    inline: "restart",
    group: "process",
    // Same as the inline button without Shift: a restored or resumed pane
    // would otherwise come back on its old conversation.
    run: () => restartPane(paneId, { continueConversation: false }),
  });
  if (resumable) {
    menuActions.push({
      id: "restart-continue",
      label: "Reiniciar continuando a conversa",
      icon: IconRestartContinue,
      group: "process",
      run: () => restartPane(paneId, { continueConversation: true }),
    });
  }
  menuActions.push({
    id: "minimize",
    label: "Minimizar",
    hint: "sai da tela; o agent segue rodando",
    icon: IconMinimizeToDock,
    shortcut: "Ctrl+Shift+M",
    inline: "minimize",
    group: "process",
    keepFocus: true,
    run: () => minimizePaneWithMotion(paneId),
  });
  if (canClose) {
    menuActions.push({
      id: "close",
      label: "Fechar terminal",
      icon: IconClose,
      shortcut: "Ctrl+Shift+W",
      group: "close",
      danger: true,
      keepFocus: true,
      run: onClose,
    });
  }

  const headerClasses = [
    "terminal-pane-header",
    isActive ? "terminal-pane-header--active" : null,
    renaming ? "terminal-pane-header--renaming" : null,
    renaming === "menu" ? "terminal-pane-header--renaming-menu" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={headerRef} className={headerClasses} onClick={onFocus}>
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
          <span
            className="terminal-pane-header__branch"
            title={gitContext?.repoRoot ? `${branchLabel} — ${gitContext.repoRoot}` : branchLabel}
          >
            <IconGitBranch size={10} className="terminal-pane-header__branch-icon" />
            <span className="terminal-pane-header__branch-text">{branchLabel}</span>
          </span>
        )}
        <span className="terminal-pane-header__conversation-group">
          <PaneConversationName
            paneId={paneId}
            conversation={conversation}
            editing={renaming !== false}
            onEditingChange={(editing) => setRenaming(editing ? "inline" : false)}
          />
          <ResumeSessionMenu
            paneId={paneId}
            agentProfileId={agentProfileId}
            cwd={cwd}
            claudeAccountId={claudeAccountId}
            handleRef={resumeMenuRef}
            onScreen={onScreen}
          />
        </span>
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
            <span className="terminal-pane-header__context-prefix">ctx </span>
            {contextPercent}%
          </span>
        )}
        <PaneStatusChip view={view} tooltip={statusTooltip} />
        {view.tone === "fallback" && (
          <button
            type="button"
            className="terminal-pane-header__restart-agent"
            data-pane-action="restart-agent"
            title={`${
              runtime?.agentExitCode === 0
                ? "Agent saiu"
                : runtime?.agentExitCode !== undefined
                  ? `Agent caiu (código ${runtime.agentExitCode})`
                  : "Agent caiu"
            } — shell ativo. Nova conversa. Segure Shift para continuar a anterior.`}
            aria-label="Reiniciar agent"
            onClick={(event) => {
              event.stopPropagation();
              restartPane(paneId, {
                continueConversation: event.shiftKey,
              });
            }}
          >
            <IconRefresh size={12} className="terminal-pane-header__restart-agent-icon" />
            <span className="terminal-pane-header__restart-agent-text">Reiniciar agent</span>
          </button>
        )}
        <span className="terminal-pane-header__mic-slot" data-pane-action="voice">
          <VoiceInputButton paneId={paneId} />
        </span>
        {canIsolate && (
          <button
            type="button"
            className="terminal-pane-header__action"
            data-pane-action="isolate"
            disabled={isolating}
            title="Isolar em worktree: branch agent-N em pasta irmã, com os arquivos ignorados copiados. Reinicia só este terminal."
            aria-label="Isolar este terminal em um worktree"
            onClick={(event) => {
              event.stopPropagation();
              isolate();
            }}
          >
            <IconGitBranch size={13} />
          </button>
        )}
        {canMaximize && (
          <button
            type="button"
            className={
              isMaximized
                ? "terminal-pane-header__action terminal-pane-header__action--on"
                : "terminal-pane-header__action"
            }
            data-pane-action="maximize"
            title={
              isMaximized
                ? `Restaurar os outros terminais (${formatShortcut("Ctrl+Shift+Z")})`
                : `Expandir: só este terminal na área da sessão (${formatShortcut("Ctrl+Shift+Z")})`
            }
            aria-label={
              isMaximized
                ? "Restaurar layout da sessão"
                : `Expandir ${shortLabel}`
            }
            aria-pressed={isMaximized}
            onClick={(event) => {
              event.stopPropagation();
              toggleMaximized();
            }}
          >
            {isMaximized ? <IconMinimize size={13} /> : <IconMaximize size={13} />}
          </button>
        )}
        <button
          type="button"
          className="terminal-pane-header__action"
          data-pane-action="split-v"
          title={`Dividir abaixo (${formatShortcut("Ctrl+\\")})`}
          aria-label="Dividir verticalmente"
          onClick={(event) => {
            event.stopPropagation();
            split("vertical");
          }}
        >
          <IconSplitVertical size={13} />
        </button>
        <button
          type="button"
          className="terminal-pane-header__action"
          data-pane-action="split-h"
          title={`Dividir ao lado (${formatShortcut("Ctrl+Shift+\\")})`}
          aria-label="Dividir horizontalmente"
          onClick={(event) => {
            event.stopPropagation();
            split("horizontal");
          }}
        >
          <IconSplitHorizontal size={13} />
        </button>
        <button
          type="button"
          className="terminal-pane-header__action"
          data-pane-action="restart"
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
        <button
          type="button"
          className="terminal-pane-header__action"
          data-pane-action="minimize"
          title={`Minimizar (${formatShortcut("Ctrl+Shift+M")}): sai da tela e o agent segue rodando; o status fica num card da sessão`}
          aria-label={`Minimizar ${shortLabel}`}
          onClick={(event) => {
            event.stopPropagation();
            minimizePaneWithMotion(paneId);
          }}
        >
          <IconMinimizeToDock size={13} />
        </button>
        <PaneActionsMenu
          paneId={paneId}
          label={`Mais ações de ${shortLabel}`}
          actions={menuActions}
          hostRef={headerRef}
          onActivate={onFocus}
          renderHeader={() => (
            <>
              <div
                className={`pane-actions-menu__status pane-actions-menu__status--${view.tone}`}
              >
                <StatusDot tone={view.tone} title={null} />
                <span>{formatStatusDetail(view, Date.now())}</span>
              </div>
              {isConversationHidden() && (
                <div className="pane-actions-menu__conversation" title={conversationName}>
                  <span className="pane-actions-menu__conversation-label">Conversa:</span>{" "}
                  <span
                    className={
                      conversation.name
                        ? "pane-actions-menu__conversation-name"
                        : "pane-actions-menu__conversation-name pane-actions-menu__conversation-name--empty"
                    }
                  >
                    {conversationName}
                  </span>
                </div>
              )}
              <div className="pane-actions-menu__context">
                <span className="pane-actions-menu__context-item" title={cwd}>
                  <IconFolder size={11} />
                  <span>{folderName}</span>
                </span>
                {branchLabel && (
                  <span className="pane-actions-menu__context-item" title={branchLabel}>
                    <IconGitBranch size={11} />
                    <span>{branchLabel}</span>
                  </span>
                )}
                {contextPercent !== undefined && (
                  <span
                    className="pane-actions-menu__context-item pane-actions-menu__context-item--ctx"
                    style={{ color: contextColor(contextPercent) }}
                  >
                    ctx {contextPercent}%
                  </span>
                )}
              </div>
            </>
          )}
        />
        {canClose && (
          <button
            type="button"
            className="terminal-pane-header__action terminal-pane-header__close"
            data-pane-action="close"
            title={`Fechar terminal (${formatShortcut("Ctrl+Shift+W")})`}
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
