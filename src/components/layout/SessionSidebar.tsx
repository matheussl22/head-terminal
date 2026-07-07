import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";

import { createInitialSession } from "../../core/agent-launcher";
import { formatSessionStatusLine } from "../../core/activity-duration";
import {
  countWorkingSessions,
  getSessionActivity,
} from "../../core/activity-utils";
import { flipAnimate } from "../../core/flip-animate";
import { pickGitContextForSession } from "../../core/git-context-utils";
import { collectPaneIds } from "../../core/session-layout";
import { useSessionStore } from "../../core/session-manager";
import {
  loadSidebarCollapsed,
  saveSidebarCollapsed,
} from "../../core/ui-preferences";
import {
  ACTIVITY_LABEL,
  NEEDS_ATTENTION,
  type PaneActivity,
} from "../../types/activity";
import type { AgentSession } from "../../types/session";
import { GitBranchBadge } from "../ui/GitBranchBadge";
import {
  IconAgentClaude,
  IconAgentCodex,
  IconAgentCursor,
  IconAgentShell,
  IconClose,
  IconPencil,
  IconPlus,
  IconSidebarCollapse,
  IconSidebarExpand,
} from "../ui/Icons";
import { StatusDot } from "../ui/StatusDot";
import { SessionContextMenu } from "./SessionContextMenu";

interface SessionSidebarProps {
  sessions: AgentSession[];
  onCreateSession: () => void;
  renameSessionId: string | null;
  onRenameComplete: () => void;
  onRenameRequest: (sessionId: string) => void;
}

const AGENT_ICON: Record<string, ComponentType<{ size?: number }>> = {
  cursor: IconAgentCursor,
  claude: IconAgentClaude,
  codex: IconAgentCodex,
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

const ATTENTION_ACTIVITIES: ReadonlySet<PaneActivity> = new Set([
  "working",
  "waiting_input",
  "error",
  "agent_fallback",
]);

function SessionStatusLine({
  activity,
  activitySince,
}: {
  activity: PaneActivity;
  activitySince: number | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!activitySince || !ATTENTION_ACTIVITIES.has(activity)) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activity, activitySince]);

  return <span>{formatSessionStatusLine(activity, activitySince, now)}</span>;
}

function paneDotsKey(
  paneIds: string[],
  paneRuntime: Record<string, { activity?: PaneActivity } | undefined>,
): string {
  return paneIds
    .map((paneId) => paneRuntime[paneId]?.activity ?? "starting")
    .join("|");
}

interface SessionListItemProps {
  session: AgentSession;
  sessionIndex: number;
  isActive: boolean;
  collapsed: boolean;
  forceRename: boolean;
  onSelect: () => void;
  onSelectPane: (paneId: string) => void;
  onRename: (title: string) => void;
  onRemove: () => void;
  onCwdChange: (cwd: string) => void;
  onRenameComplete: () => void;
  onContextMenu: (event: React.MouseEvent, session: AgentSession) => void;
  onDragStart: (index: number) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent, index: number) => void;
  onDrop: (index: number) => void;
}

const SessionListItem = memo(function SessionListItem({
  session,
  sessionIndex,
  isActive,
  collapsed,
  forceRename,
  onSelect,
  onSelectPane,
  onRename,
  onRemove,
  onCwdChange,
  onRenameComplete,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: SessionListItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);
  const [draftCwd, setDraftCwd] = useState(session.cwd);
  // Fechar sessão exige dois cliques: um clique perdido não pode matar uma sessão.
  const [confirmRemove, setConfirmRemove] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const paneIds = collectPaneIds(session.layout);
  const activity = useSessionStore((state) =>
    getSessionActivity(session, state.paneRuntime),
  );
  const activitySince = useSessionStore((state) => {
    let bestSince = 0;
    for (const paneId of paneIds) {
      const since = state.paneRuntime[paneId]?.activitySince ?? 0;
      if (since > bestSince) {
        bestSince = since;
      }
    }
    return bestSince || undefined;
  });
  const dotsKey = useSessionStore((state) =>
    paneDotsKey(paneIds, state.paneRuntime),
  );
  const paneActivities = dotsKey.split("|") as PaneActivity[];
  const gitContext = useSessionStore((state) =>
    pickGitContextForSession(
      session.id,
      paneIds,
      state.paneGitContext,
      state.sessionGitContext,
      {
        activePaneId: state.activePaneId,
        isActiveSession: session.id === state.activeSessionId,
      },
    ),
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
    setDraftCwd(session.cwd);
  }, [session.cwd]);

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

  const commitCwd = () => {
    const nextCwd = draftCwd.trim();
    if (nextCwd && nextCwd !== session.cwd) {
      if (
        window.confirm(
          "Alterar a pasta reinicia os terminais da sessão. Continuar?",
        )
      ) {
        onCwdChange(nextCwd);
      } else {
        setDraftCwd(session.cwd);
      }
    } else {
      setDraftCwd(session.cwd);
    }
  };

  if (collapsed) {
    const ringClass = ATTENTION_ACTIVITIES.has(activity)
      ? ` session-sidebar__compact-item--ring-${activity}`
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
          title={`${session.title} — ${ACTIVITY_LABEL[activity]}${gitContext?.branch ? ` — ${gitContext.branch}` : ""}`}
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
          (NEEDS_ATTENTION.has(activity)
            ? ` session-sidebar__item--glow-${activity}`
            : "")
        }
        onContextMenu={(event) => onContextMenu(event, session)}
        onMouseLeave={() => setConfirmRemove(false)}
      >
        <button
          type="button"
          className="session-sidebar__select"
          onClick={onSelect}
        >
          <div className="session-sidebar__title-row">
            <StatusDot activity={activity} />
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
          </div>

          <span className="session-sidebar__meta">{session.cwd}</span>
          <GitBranchBadge
            context={gitContext}
            className="session-sidebar__git-badge"
          />
          <span className="session-sidebar__status">
            <span className="session-sidebar__pane-dots" aria-hidden>
              {paneActivities.map((paneActivity, index) => (
                <button
                  key={paneIds[index]}
                  type="button"
                  className={`session-sidebar__pane-dot session-sidebar__pane-dot--${paneActivity}`}
                  title={`Terminal ${index + 1} — ${ACTIVITY_LABEL[paneActivity]}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectPane(paneIds[index]);
                  }}
                />
              ))}
            </span>
            <SessionStatusLine activity={activity} activitySince={activitySince} />
          </span>
        </button>

        {isActive && (
          <div className="session-sidebar__settings">
            <input
              className="session-sidebar__cwd-input"
              value={draftCwd}
              onChange={(event) => setDraftCwd(event.target.value)}
              onBlur={commitCwd}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitCwd();
                }
              }}
              onClick={(event) => event.stopPropagation()}
            />
          </div>
        )}

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
              className={
                confirmRemove
                  ? "session-sidebar__action session-sidebar__action--remove session-sidebar__action--confirm"
                  : "session-sidebar__action session-sidebar__action--remove"
              }
              title={
                confirmRemove ? "Clique de novo para fechar" : "Fechar sessão"
              }
              aria-label={`Fechar ${session.title}`}
              onClick={(event) => {
                event.stopPropagation();
                if (!confirmRemove) {
                  setConfirmRemove(true);
                  window.setTimeout(() => setConfirmRemove(false), 3000);
                  return;
                }
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
  const workingCount = useSessionStore((state) =>
    countWorkingSessions(state.sessions, state.paneRuntime),
  );
  // A ordem é sempre a do store (pin + drag manual) — sem reordenação
  // automática; quem precisa de atenção sinaliza por cor/glow, não por posição.
  const listRef = useRef<HTMLUListElement | null>(null);
  const listTops = useRef<Map<string, number>>(new Map());
  useLayoutEffect(() => {
    if (listRef.current) {
      listTops.current = flipAnimate(listRef.current, listTops.current);
    }
  });

  const setActiveSessionId = useSessionStore((state) => state.setActiveSessionId);
  const setActivePaneId = useSessionStore((state) => state.setActivePaneId);
  const renameSession = useSessionStore((state) => state.renameSession);
  const removeSession = useSessionStore((state) => state.removeSession);
  const addSession = useSessionStore((state) => state.addSession);
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

  const focusSessionPane = (sessionId: string, paneId: string) => {
    setActiveSessionId(sessionId);
    setActivePaneId(paneId);
  };

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
            {workingCount > 0 && (
              <span
                className="session-sidebar__working-badge"
                title={`${workingCount} sessão(ões) executando`}
              >
                {workingCount}
              </span>
            )}
          </span>
        )}

        <div className="session-sidebar__header-actions">
          {!collapsed && (
            <button
              type="button"
              className="session-sidebar__new"
              title="Nova sessão"
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
            sessionIndex={index}
            collapsed={collapsed}
            isActive={session.id === activeSessionId}
            forceRename={renameSessionId === session.id}
            onSelect={() => setActiveSessionId(session.id)}
            onSelectPane={(paneId) => focusSessionPane(session.id, paneId)}
            onRename={(title) => renameSession(session.id, title)}
            onRemove={() => removeSession(session.id)}
            onCwdChange={(cwd) => updateSessionCwd(session.id, cwd)}
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

      {collapsed && (
        <div className="session-sidebar__footer">
          <button
            type="button"
            className="session-sidebar__compact-new"
            title="Nova sessão"
            aria-label="Nova sessão"
            onClick={onCreateSession}
          >
            <IconPlus size={16} />
          </button>
        </div>
      )}

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
          onDuplicate={() => {
            addSession(
              createInitialSession(
                contextMenu.session.cwd,
                `${contextMenu.session.title} (cópia)`,
                contextMenu.session.agentProfileId,
              ),
            );
            setContextMenu(null);
          }}
          onClose={() => {
            removeSession(contextMenu.session.id);
            setContextMenu(null);
          }}
        />
      )}
    </aside>
  );
}
