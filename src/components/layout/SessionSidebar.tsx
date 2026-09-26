import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";

import {
  describePaneStatus,
  describeSessionStatus,
  formatStatusDetail,
  formatStatusLine,
  TICKING_TONES,
  TONE_LABEL,
  type PaneStatusRuntime,
  type PaneStatusView,
  type SessionStatusView,
} from "../../core/activity-display";
import { getClaudeAccountProfile } from "../../core/claude-accounts";
import { flipAnimate } from "../../core/flip-animate";
import { revealPane } from "../../core/pane-minimize";
import { samePath } from "../../core/path-utils";
import { collectPaneIds } from "../../core/session-layout";
import { useSessionStore } from "../../core/session-manager";
import { formatShortcut } from "../../core/shortcuts";
import {
  closeSessionWithWorktreeReview,
  isolateSessionInWorktree,
} from "../../core/worktree";
import { duplicateSessionIsolated } from "../../actions/duplicateSession";
import {
  loadSidebarCollapsed,
  saveSidebarCollapsed,
} from "../../core/ui-preferences";
import type { AgentSession } from "../../types/session";
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
  IconPlus,
  IconSidebarCollapse,
  IconSidebarExpand,
} from "../ui/Icons";
import { StatusDot, useTerminalStatusCounts } from "../ui/StatusDot";
import { SessionContextMenu } from "./SessionContextMenu";
import { SystemResourceMeter } from "./SystemResourceMeter";

interface SessionSidebarProps {
  sessions: AgentSession[];
  onCreateSession: () => void;
  renameSessionId: string | null;
  onRenameComplete: () => void;
  onRenameRequest: (sessionId: string) => void;
}

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

function AgentIcon({
  agentProfileId,
  size,
}: {
  agentProfileId: string;
  size?: number;
}) {
  const Icon = AGENT_ICON[agentProfileId] ?? IconAgentShell;
  return <Icon size={size} />;
}

/** The ring around a session in the collapsed rail: only the tones worth a
 * glance from across the screen. */
const RING_TONES = new Set(["working", "waiting", "done", "error", "fallback"]);

/** "Aguardando há 2m · 1 aguardando · 3 executando". The clock only ticks
 * while the session's tone keeps counting (working, waiting, done…); the
 * pane counts come from the store, so they need no timer at all. */
function SessionStatusLine({ view }: { view: SessionStatusView }) {
  const ticking = view.since !== undefined && TICKING_TONES.has(view.tone);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking, view.since]);

  const detail = formatStatusDetail(view, now);
  return (
    <span
      className="session-sidebar__status-text"
      title={view.summary ? `${detail}\n${view.summary}` : detail}
    >
      <span className="session-sidebar__status-label">{formatStatusLine(view, now)}</span>
      {view.summary && (
        <span className="session-sidebar__status-summary"> · {view.summary}</span>
      )}
    </span>
  );
}

/** What of a pane's runtime the sidebar shows, as a string: the selector
 * returns it so context-percent pings don't re-render the list. */
function paneStatusKey(runtime: PaneStatusRuntime | undefined): string {
  if (!runtime) {
    return "";
  }
  return [
    runtime.activity,
    runtime.activitySince,
    runtime.doneAt ?? "",
    runtime.blockedReason ?? "",
    runtime.blockedDetail ?? "",
  ].join(":");
}

const DORMANT_PANE: PaneStatusView = {
  tone: "dormant",
  label: TONE_LABEL.dormant,
  detail: "Sessão ainda não iniciada — abre ao selecionar",
  attention: false,
};

interface SessionListItemProps {
  session: AgentSession;
  claudeAccountName?: string;
  sessionIndex: number;
  isActive: boolean;
  collapsed: boolean;
  forceRename: boolean;
  onSelect: () => void;
  onSelectPane: (paneId: string) => void;
  onRename: (title: string) => void;
  onRemove: () => void;
  onRenameComplete: () => void;
  onContextMenu: (event: React.MouseEvent, session: AgentSession) => void;
  onDragStart: (index: number) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent, index: number) => void;
  onDrop: (index: number) => void;
}

const SessionListItem = memo(function SessionListItem({
  session,
  claudeAccountName,
  sessionIndex,
  isActive,
  collapsed,
  forceRename,
  onSelect,
  onSelectPane,
  onRename,
  onRemove,
  onRenameComplete,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: SessionListItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const paneIds = useMemo(() => collectPaneIds(session.layout), [session.layout]);
  const statusKey = useSessionStore(
    (state) =>
      `${state.spawnedSessionIds[session.id] ? 1 : 0}|` +
      paneIds.map((paneId) => paneStatusKey(state.paneRuntime[paneId])).join(","),
  );
  // Rebuilt only when the key above changes; the store is read directly so
  // the selector itself can stay a cheap string.
  const { status, paneViews } = useMemo(() => {
    const state = useSessionStore.getState();
    const spawned = Boolean(state.spawnedSessionIds[session.id]);
    return {
      status: describeSessionStatus(paneIds, state.paneRuntime, { spawned }),
      paneViews: paneIds.map((paneId) =>
        spawned ? describePaneStatus(state.paneRuntime[paneId]) : DORMANT_PANE,
      ),
    };
    // statusKey stands for everything read from the store here.
  }, [statusKey, paneIds, session.id]);
  const minimizedKey = useSessionStore((state) =>
    paneIds.map((paneId) => (state.minimizedPanes[paneId] ? "1" : "0")).join(""),
  );

  useEffect(() => {
    if (forceRename) {
      setIsEditing(true);
    }
  }, [forceRename]);

  useEffect(() => {
    if (!isEditing) {
      setDraftTitle(session.title);
    }
  }, [isEditing, session.title]);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const commitRename = () => {
    const nextTitle = draftTitle.trim();
    if (nextTitle && nextTitle !== session.title) {
      onRename(nextTitle);
    } else {
      setDraftTitle(session.title);
    }
    setIsEditing(false);
    onRenameComplete();
  };

  if (collapsed) {
    const ringClass = RING_TONES.has(status.tone)
      ? ` session-sidebar__compact-item--ring-${status.tone}`
      : status.tone === "dormant"
        ? " session-sidebar__compact-item--dormant"
        : "";
    return (
      <li
        data-session-id={session.id}
        draggable
        onDragStart={() => onDragStart(sessionIndex)}
        onDragOver={(event) => onDragOver(event, sessionIndex)}
        onDragEnd={onDragEnd}
        onDrop={() => onDrop(sessionIndex)}
      >
        <button
          type="button"
          className={
            (isActive
              ? "session-sidebar__compact-item session-sidebar__compact-item--active"
              : "session-sidebar__compact-item") + ringClass
          }
          title={`${session.title}${claudeAccountName ? ` — ${claudeAccountName}` : ""} — ${formatStatusDetail(status)}${status.summary ? ` (${status.summary})` : ""}`}
          aria-label={session.title}
          onClick={onSelect}
          onContextMenu={(event) => onContextMenu(event, session)}
        >
          <AgentIcon agentProfileId={session.agentProfileId} size={16} />
        </button>
      </li>
    );
  }

  return (
    <li
      data-session-id={session.id}
      draggable
      onDragStart={() => onDragStart(sessionIndex)}
      onDragOver={(event) => onDragOver(event, sessionIndex)}
      onDragEnd={onDragEnd}
      onDrop={() => onDrop(sessionIndex)}
    >
      <div
        className={
          (isActive
            ? "session-sidebar__item session-sidebar__item--active"
            : "session-sidebar__item") +
          ""
        }
        onContextMenu={(event) => onContextMenu(event, session)}
      >
        <div
          role="button"
          tabIndex={0}
          className="session-sidebar__select"
          onClick={onSelect}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect();
            }
          }}
        >
          <div className="session-sidebar__title-row">
            <StatusDot tone={status.tone} title={formatStatusDetail(status)} />
            {session.pinned && (
              <span className="session-sidebar__pin" title="Fixada">
                📌
              </span>
            )}
            {isEditing ? (
              <input
                ref={inputRef}
                className="session-sidebar__rename-input"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setDraftTitle(session.title);
                    setIsEditing(false);
                    onRenameComplete();
                  }
                }}
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              <span
                className="session-sidebar__title"
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setIsEditing(true);
                }}
              >
                {session.title}
              </span>
            )}
            <span
              className="session-sidebar__agent-chip"
              title={session.agentProfileId}
            >
              <AgentIcon agentProfileId={session.agentProfileId} size={12} />
            </span>
            {claudeAccountName && (
              <span
                className="session-sidebar__account-chip"
                title={`Perfil Claude: ${claudeAccountName}`}
              >
                {claudeAccountName}
              </span>
            )}
          </div>

          <span
            className={`session-sidebar__status session-sidebar__status--${status.tone}`}
          >
            <span
              className={
                paneViews.length > 12
                  ? "session-sidebar__pane-dots session-sidebar__pane-dots--crowded"
                  : paneViews.length > 6
                    ? "session-sidebar__pane-dots session-sidebar__pane-dots--dense"
                    : "session-sidebar__pane-dots"
              }
              aria-hidden
            >
              {paneViews.map((paneView, index) => {
                const minimized = minimizedKey[index] === "1";
                return (
                  <button
                    key={paneIds[index]}
                    type="button"
                    tabIndex={-1}
                    className={
                      `session-sidebar__pane-dot session-sidebar__pane-dot--${paneView.tone}` +
                      (minimized ? " session-sidebar__pane-dot--minimized" : "")
                    }
                    title={
                      `Terminal ${index + 1} — ${paneView.detail}` +
                      (minimized ? " · minimizado, clique para restaurar" : "")
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      // Minimized or not, the dot shows that terminal.
                      onSelectPane(paneIds[index]);
                    }}
                  />
                );
              })}
            </span>
            <SessionStatusLine view={status} />
          </span>
        </div>

        {!isEditing && (
          <div className="session-sidebar__actions">
            <button
              type="button"
              className="session-sidebar__action session-sidebar__action--rename"
              title="Renomear sessão"
              aria-label={`Renomear ${session.title}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setIsEditing(true);
              }}
            >
              <IconPencil />
            </button>
            <button
              type="button"
              className="session-sidebar__action session-sidebar__action--remove"
              title="Fechar sessão"
              aria-label={`Fechar ${session.title}`}
              onClick={(event) => {
                // Um clique só: a confirmação fica no diálogo que o fechamento abre.
                event.stopPropagation();
                onRemove();
              }}
            >
              <IconClose />
            </button>
          </div>
        )}
      </div>
    </li>
  );
});

export function SessionSidebar({
  sessions,
  onCreateSession,
  renameSessionId,
  onRenameComplete,
  onRenameRequest,
}: SessionSidebarProps) {
  const [collapsed, setCollapsed] = useState(loadSidebarCollapsed);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    session: AgentSession;
    x: number;
    y: number;
  } | null>(null);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const counts = useTerminalStatusCounts();
  // A ordem é sempre a do store (pin + drag manual) — sem reordenação
  // automática; quem precisa de atenção sinaliza pela cor do status, não por posição.
  const listRef = useRef<HTMLUListElement | null>(null);
  const listTops = useRef<Map<string, number>>(new Map());
  // Sem deps, isso rodava (getBoundingClientRect em cada sessão = reflow
  // síncrono) em TODO re-render do sidebar, inclusive os disparados por
  // activity/context ping — não só quando a ordem muda de fato.
  const sessionOrderKey = sessions.map((session) => session.id).join(",");
  useLayoutEffect(() => {
    if (listRef.current) {
      listTops.current = flipAnimate(listRef.current, listTops.current);
    }
  }, [sessionOrderKey]);

  const setActiveSessionId = useSessionStore((state) => state.setActiveSessionId);
  const renameSession = useSessionStore((state) => state.renameSession);
  const updateSessionCwd = useSessionStore((state) => state.updateSessionCwd);
  const reorderSessions = useSessionStore((state) => state.reorderSessions);
  const togglePinSession = useSessionStore((state) => state.togglePinSession);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      saveSidebarCollapsed(next);
      return next;
    });
  };

  // A pane dot shows that terminal wherever it sits — another session, the
  // dock, behind a zoomed sibling — and hands it the keyboard.
  const focusSessionPane = (paneId: string) => revealPane(paneId);

  const handleContextMenu = (
    event: React.MouseEvent,
    session: AgentSession,
  ) => {
    event.preventDefault();
    setContextMenu({ session, x: event.clientX, y: event.clientY });
  };

  const handleDrop = useCallback(
    (toIndex: number) => {
      if (dragFrom === null || dragFrom === toIndex) {
        return;
      }
      reorderSessions(dragFrom, toIndex);
      setDragFrom(null);
    },
    [dragFrom, reorderSessions],
  );

  const dismissContextMenu = useCallback(() => setContextMenu(null), []);

  return (
    <aside
      className={
        collapsed
          ? "session-sidebar session-sidebar--collapsed"
          : "session-sidebar"
      }
      aria-label="Sessões de agent"
    >
      <div className="session-sidebar__header">
        {!collapsed && (
          <span className="session-sidebar__header-title">
            Sessões
            {counts.waiting > 0 && (
              <span
                className="session-sidebar__count-badge session-sidebar__count-badge--waiting"
                title={`${counts.waiting} ${counts.waiting === 1 ? "terminal aguardando" : "terminais aguardando"} sua resposta`}
              >
                {counts.waiting}
              </span>
            )}
            {counts.working > 0 && (
              <span
                className="session-sidebar__count-badge session-sidebar__count-badge--working"
                title={`${counts.working} ${counts.working === 1 ? "terminal executando" : "terminais executando"}`}
              >
                {counts.working}
              </span>
            )}
          </span>
        )}

        <div className="session-sidebar__header-actions">
          {!collapsed && (
            <button
              type="button"
              className="session-sidebar__new"
              title={`Nova sessão (${formatShortcut("Ctrl+Shift+N")})`}
              onClick={onCreateSession}
            >
              <IconPlus size={12} />
              <span>Nova</span>
            </button>
          )}

          <button
            type="button"
            className="session-sidebar__toggle"
            title={collapsed ? "Expandir menu" : "Recolher menu"}
            aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
            onClick={toggleCollapsed}
          >
            {collapsed ? <IconSidebarExpand /> : <IconSidebarCollapse />}
          </button>
        </div>
      </div>

      <ul className="session-sidebar__list" ref={listRef}>
        {sessions.map((session, index) => (
          <SessionListItem
            key={session.id}
            session={session}
            claudeAccountName={
              session.agentProfileId === "claude"
                ? getClaudeAccountProfile(session.claudeAccountId)?.name
                : undefined
            }
            sessionIndex={index}
            collapsed={collapsed}
            isActive={session.id === activeSessionId}
            forceRename={renameSessionId === session.id}
            onSelect={() => setActiveSessionId(session.id)}
            onSelectPane={focusSessionPane}
            onRename={(title) => renameSession(session.id, title)}
            onRemove={() => void closeSessionWithWorktreeReview(session.id)}
            onRenameComplete={onRenameComplete}
            onContextMenu={handleContextMenu}
            onDragStart={setDragFrom}
            onDragEnd={() => setDragFrom(null)}
            onDragOver={(event, index) => {
              event.preventDefault();
              if (dragFrom !== null && dragFrom !== index) {
                event.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={handleDrop}
          />
        ))}
      </ul>

      <div className="session-sidebar__footer">
        {collapsed && (
          <button
            type="button"
            className="session-sidebar__compact-new"
            title={`Nova sessão (${formatShortcut("Ctrl+Shift+N")})`}
            aria-label="Nova sessão"
            onClick={onCreateSession}
          >
            <IconPlus size={16} />
          </button>
        )}
        <SystemResourceMeter collapsed={collapsed} />
      </div>

      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          pinned={Boolean(contextMenu.session.pinned)}
          onDismiss={dismissContextMenu}
          onRename={() => {
            onRenameRequest(contextMenu.session.id);
            setContextMenu(null);
          }}
          onTogglePin={() => {
            togglePinSession(contextMenu.session.id);
            setContextMenu(null);
          }}
          onChangeFolder={() => {
            const { session } = contextMenu;
            setContextMenu(null);
            void window.headTerminal.system
              .selectDirectory(session.cwd)
              .then((selected) => {
                if (typeof selected !== "string" || !selected || samePath(selected, session.cwd)) {
                  return;
                }
                if (
                  window.confirm(
                    "Alterar a pasta reinicia os terminais da sessão. Continuar?",
                  )
                ) {
                  updateSessionCwd(session.id, selected);
                }
              })
              .catch(() => undefined);
          }}
          onIsolate={
            contextMenu.session.worktree
              ? undefined
              : () => {
                  const { session } = contextMenu;
                  setContextMenu(null);
                  void isolateSessionInWorktree(session.id);
                }
          }
          onDuplicate={() => {
            const { session } = contextMenu;
            setContextMenu(null);
            // Duplicar é o caminho mais curto para dois agents na mesma pasta:
            // a original já está na árvore, então a cópia ganha a sua.
            void duplicateSessionIsolated(session);
          }}
          onClose={() => {
            void closeSessionWithWorktreeReview(contextMenu.session.id);
            setContextMenu(null);
          }}
        />
      )}
    </aside>
  );
}
