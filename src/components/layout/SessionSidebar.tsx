import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
} from "react";

import {
  describeHibernatedPaneStatus,
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
import { getSessionShownAgent } from "../../core/activity-utils";
import {
  getClaudeAccountProfile,
  loadClaudeAccountProfiles,
} from "../../core/claude-accounts";
import { flipAnimate } from "../../core/flip-animate";
import { revealPane } from "../../core/pane-minimize";
import { samePath } from "../../core/path-utils";
import {
  claudeAccountFilterOptions,
  filterSessionsByClaudeAccount,
} from "../../core/session-filter";
import { collectPaneIds } from "../../core/session-layout";
import { useSessionStore } from "../../core/session-manager";
import { formatShortcut } from "../../core/shortcuts";
import { msg } from "../../i18n";
import { useLocale } from "../../i18n/react";
import {
  closeSessionWithWorktreeReview,
  isolateSessionInWorktree,
} from "../../core/worktree";
import { duplicateSessionIsolated } from "../../actions/duplicateSession";
import { hibernateSessionFromMenu } from "../../actions/hibernateSession";
import {
  SIDEBAR_WIDTH_DEFAULT,
  clampSidebarWidth,
  loadSidebarCollapsed,
  loadSidebarWidth,
  saveSidebarCollapsed,
  saveSidebarWidth,
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
  IconHibernate,
  IconPencil,
  IconPlus,
  IconSidebarCollapse,
  IconSidebarExpand,
} from "../ui/Icons";
import { StatusDot, useTerminalStatusCounts } from "../ui/StatusDot";
import { ProjectGroups } from "./ProjectGroups";
import { ProjectDropTargets, ProjectSwitcher } from "./ProjectSwitcher";
import { SessionContextMenu } from "./SessionContextMenu";
import { SystemResourceMeter } from "./SystemResourceMeter";
import { UsageMeter } from "./UsageMeter";

interface SessionSidebarProps {
  sessions: AgentSession[];
  /** With a project: the new session goes there (grouped view's "+"). */
  onCreateSession: (projectId?: string) => void;
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

function filterChipClass(active: boolean): string {
  return active
    ? "session-sidebar__filter-chip session-sidebar__filter-chip--active"
    : "session-sidebar__filter-chip";
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

// Getters: built once at import, read when shown — a language switch applies.
const DORMANT_PANE: PaneStatusView = {
  tone: "dormant",
  get label() {
    return TONE_LABEL.dormant;
  },
  get detail() {
    return msg.core.status.detail.dormant;
  },
  attention: false,
};

interface SessionListItemProps {
  session: AgentSession;
  claudeAccountName?: string;
  sessionIndex: number;
  isActive: boolean;
  collapsed: boolean;
  /** Grouped view: one line while the session has nothing to report. */
  dense?: boolean;
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
  dense = false,
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
  const locale = useLocale();
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const paneIds = useMemo(() => collectPaneIds(session.layout), [session.layout]);
  const statusKey = useSessionStore(
    (state) =>
      `${state.spawnedSessionIds[session.id] ? 1 : 0}|` +
      `${state.hibernatedSessions[session.id] ? 1 : 0}|` +
      paneIds.map((paneId) => paneStatusKey(state.paneRuntime[paneId])).join(","),
  );
  // Rebuilt only when the key above changes; the store is read directly so
  // the selector itself can stay a cheap string.
  const { status, paneViews, hibernated } = useMemo(() => {
    const state = useSessionStore.getState();
    const spawned = Boolean(state.spawnedSessionIds[session.id]);
    const hibernated = !spawned && Boolean(state.hibernatedSessions[session.id]);
    return {
      hibernated,
      status: describeSessionStatus(paneIds, state.paneRuntime, { spawned, hibernated }),
      paneViews: paneIds.map((paneId) =>
        spawned
          ? describePaneStatus(state.paneRuntime[paneId])
          : hibernated
            ? describeHibernatedPaneStatus(state.paneRuntime[paneId])
            : DORMANT_PANE,
      ),
    };
    // statusKey stands for everything read from the store here; the views
    // carry their text, so a language switch rebuilds them too.
  }, [statusKey, paneIds, session.id, locale]);
  const minimizedKey = useSessionStore((state) =>
    paneIds.map((paneId) => (state.minimizedPanes[paneId] ? "1" : "0")).join(""),
  );
  const shownAgent = useSessionStore((state) =>
    getSessionShownAgent(session, state.paneRuntime),
  );
  // `claude` typed in a shell runs on the terminal's own ~/.claude, not on
  // one of the app's profiles: the chip says which one it really is.
  const claudeInShell = shownAgent !== session.agentProfileId;
  const accountLabel = claudeInShell ? "~/.claude" : claudeAccountName;

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
          title={`${session.title}${accountLabel ? ` — ${accountLabel}` : ""} — ${formatStatusDetail(status)}${status.summary ? ` (${status.summary})` : ""}`}
          aria-label={session.title}
          onClick={onSelect}
          onContextMenu={(event) => onContextMenu(event, session)}
        >
          <AgentIcon agentProfileId={shownAgent} size={16} />
        </button>
      </li>
    );
  }

  // The status line only while the session works, waits, finished or failed.
  const quiet = dense && !RING_TONES.has(status.tone);

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
          (quiet ? " session-sidebar__item--quiet" : "")
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
              <span className="session-sidebar__pin" title={msg.sidebar.pinned}>
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
            {/* One-line row: no status line to carry the hibernated mark. */}
            {quiet && hibernated && (
              <span className="session-sidebar__hibernated" title={msg.core.status.detail.hibernated}>
                <IconHibernate size={11} />
              </span>
            )}
            <span
              className="session-sidebar__agent-chip"
              title={claudeInShell ? msg.sidebar.claudeInShell : session.agentProfileId}
            >
              <AgentIcon agentProfileId={shownAgent} size={12} />
            </span>
            {accountLabel && (
              <span
                className="session-sidebar__account-chip"
                title={
                  claudeInShell
                    ? msg.sidebar.claudeInShellAccount
                    : msg.sidebar.claudeProfile(accountLabel)
                }
              >
                {accountLabel}
              </span>
            )}
          </div>

          {!quiet && (
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
                        msg.sidebar.paneDot(index + 1, paneView.detail) +
                        (minimized ? msg.sidebar.paneDotMinimized : "")
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
              {hibernated && (
                <span className="session-sidebar__hibernated" title={msg.core.status.detail.hibernated}>
                  <IconHibernate size={11} />
                </span>
              )}
            </span>
          )}
        </div>

        {!isEditing && (
          <div className="session-sidebar__actions">
            <button
              type="button"
              className="session-sidebar__action session-sidebar__action--rename"
              title={msg.sidebar.rename}
              aria-label={msg.sidebar.renameAria(session.title)}
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
              title={msg.sidebar.close}
              aria-label={msg.sidebar.closeAria(session.title)}
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
  const [width, setWidth] = useState(loadSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    session: AgentSession;
    x: number;
    y: number;
  } | null>(null);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const projectsEnabled = useSessionStore((state) => state.projectsEnabled);
  const activeProjectId = useSessionStore((state) => state.activeProjectId);
  const projects = useSessionStore((state) => state.projects);
  const projectsView = useSessionStore((state) => state.projectsView);
  // Grouped view: every project in the list, each under its own header.
  const grouped = projectsEnabled && projectsView === "grouped";
  // One project at a time lists the project on screen; the profile filter and
  // the count then apply to its sessions. The grouped view lists them all.
  const projectSessions = useMemo(
    () =>
      grouped || !projectsEnabled
        ? sessions
        : sessions.filter((session) => session.projectId === activeProjectId),
    [activeProjectId, grouped, projectsEnabled, sessions],
  );
  const claudeProfiles = loadClaudeAccountProfiles();
  // The chips come from every session, in any project: a project whose
  // sessions all run on one profile must not take them away.
  const accountOptions = claudeAccountFilterOptions(sessions, claudeProfiles);
  // O filtro só vale enquanto os chips estão na tela: recolhido, ou com um
  // perfil só, a lista nunca esconde sessões sem mostrar por quê.
  const showAccountFilter = !collapsed && accountOptions.length > 1;
  const activeAccountFilter =
    showAccountFilter && accountOptions.some((option) => option.id === accountFilter)
      ? accountFilter
      : null;
  const visibleSessions = filterSessionsByClaudeAccount(projectSessions, activeAccountFilter);
  const counts = useTerminalStatusCounts();
  // A ordem é sempre a do store (pin + drag manual) — sem reordenação
  // automática; quem precisa de atenção sinaliza pela cor do status, não por posição.
  const listRef = useRef<HTMLUListElement | null>(null);
  const listTops = useRef<Map<string, number>>(new Map());
  // Sem deps, isso rodava (getBoundingClientRect em cada sessão = reflow
  // síncrono) em TODO re-render do sidebar, inclusive os disparados por
  // activity/context ping — não só quando a ordem muda de fato.
  const sessionOrderKey = visibleSessions.map((session) => session.id).join(",");
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

  const resizeTarget = (event: React.PointerEvent): number | null => {
    const start = resizeStart.current;
    return start ? clampSidebarWidth(start.width + event.clientX - start.x) : null;
  };

  const finishResize = (finalWidth: number) => {
    resizeStart.current = null;
    setResizing(false);
    setWidth(finalWidth);
    saveSidebarWidth(finalWidth);
  };

  const onResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    // Capturado, o arraste fica com a alça mesmo passando sobre um terminal,
    // que senão mandaria o movimento ao agent como relatório de mouse.
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = { x: event.clientX, width };
    setResizing(true);
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
      const store = useSessionStore.getState();
      const dragged = store.sessions[dragFrom];
      const target = store.sessions[toIndex];
      // Grouped view, dropped on a session of another project: it moves there
      // and takes that session's place.
      if (grouped && dragged && target?.projectId && dragged.projectId !== target.projectId) {
        store.moveSessionToProject(dragged.id, target.projectId);
        const moved = useSessionStore.getState().sessions;
        reorderSessions(
          moved.findIndex((session) => session.id === dragged.id),
          moved.findIndex((session) => session.id === target.id),
        );
      } else {
        reorderSessions(dragFrom, toIndex);
      }
      setDragFrom(null);
    },
    [dragFrom, grouped, reorderSessions],
  );

  const dismissContextMenu = useCallback(() => setContextMenu(null), []);

  const renderSessionItem = (session: AgentSession) => (
    <SessionListItem
      key={session.id}
      session={session}
      claudeAccountName={
        session.agentProfileId === "claude"
          ? getClaudeAccountProfile(session.claudeAccountId)?.name
          : undefined
      }
      // Índice no store, não na lista filtrada: é nele que o drag reordena.
      sessionIndex={sessions.indexOf(session)}
      collapsed={collapsed}
      dense={grouped}
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
  );

  return (
    <aside
      className={
        (collapsed
          ? "session-sidebar session-sidebar--collapsed"
          : "session-sidebar") +
        (resizing ? " session-sidebar--resizing" : "")
      }
      style={{ "--sidebar-width": `${width}px` } as CSSProperties}
      aria-label={msg.sidebar.ariaLabel}
    >
      <div className="session-sidebar__header">
        {!collapsed && (
          <span className="session-sidebar__header-title">
            {msg.sidebar.title}
            {/* Quantas sessões a lista tem (com filtro, quantas dele sobraram),
                depois os terminais aguardando você e os executando. */}
            {projectSessions.length > 0 && (
              <span
                className="session-sidebar__count-badge session-sidebar__count-badge--total"
                title={
                  visibleSessions.length === projectSessions.length
                    ? msg.sidebar.count(projectSessions.length)
                    : msg.sidebar.countFiltered(
                        visibleSessions.length,
                        projectSessions.length,
                      )
                }
              >
                {visibleSessions.length === projectSessions.length
                  ? projectSessions.length
                  : `${visibleSessions.length}/${projectSessions.length}`}
              </span>
            )}
            {counts.waiting > 0 && (
              <span
                className="session-sidebar__count-badge session-sidebar__count-badge--waiting"
                title={msg.sidebar.waitingCount(counts.waiting)}
              >
                {counts.waiting}
              </span>
            )}
            {counts.working > 0 && (
              <span
                className="session-sidebar__count-badge session-sidebar__count-badge--working"
                title={msg.sidebar.workingCount(counts.working)}
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
              title={msg.sidebar.newSessionHint(formatShortcut("Ctrl+Shift+N"))}
              onClick={() => onCreateSession()}
            >
              <IconPlus size={12} />
              <span>{msg.sidebar.newSession}</span>
            </button>
          )}

          <button
            type="button"
            className="session-sidebar__toggle"
            title={collapsed ? msg.sidebar.expand : msg.sidebar.collapse}
            aria-label={collapsed ? msg.sidebar.expand : msg.sidebar.collapse}
            onClick={toggleCollapsed}
          >
            {collapsed ? <IconSidebarExpand /> : <IconSidebarCollapse />}
          </button>
        </div>
      </div>

      {projectsEnabled && !grouped && <ProjectSwitcher collapsed={collapsed} />}

      {showAccountFilter && (
        <div
          className="session-sidebar__filter"
          role="group"
          aria-label={msg.sidebar.profileFilterAria}
        >
          <button
            type="button"
            className={filterChipClass(activeAccountFilter === null)}
            aria-pressed={activeAccountFilter === null}
            onClick={() => setAccountFilter(null)}
          >
            {msg.sidebar.profileFilterAll}
          </button>
          {accountOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className={filterChipClass(activeAccountFilter === option.id)}
              aria-pressed={activeAccountFilter === option.id}
              title={msg.sidebar.profileFilterOnly(option.label)}
              onClick={() =>
                setAccountFilter((current) => (current === option.id ? null : option.id))
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      {grouped ? (
        <ProjectGroups
          sessions={visibleSessions}
          filtering={activeAccountFilter !== null}
          collapsed={collapsed}
          dragSession={dragFrom !== null ? (sessions[dragFrom] ?? null) : null}
          onDropSession={(projectId) => {
            if (dragFrom !== null && sessions[dragFrom]) {
              useSessionStore.getState().moveSessionToProject(sessions[dragFrom].id, projectId);
            }
            setDragFrom(null);
          }}
          onCreateSession={(projectId) => onCreateSession(projectId)}
          renderSession={renderSessionItem}
        />
      ) : (
        <ul className="session-sidebar__list" ref={listRef}>
          {visibleSessions.map(renderSessionItem)}
        </ul>
      )}

      {/* Below the list, so it opens without shifting the session being dragged. */}
      {projectsEnabled && dragFrom !== null && sessions[dragFrom] && (
        <ProjectDropTargets
          session={sessions[dragFrom]}
          collapsed={collapsed}
          onDropped={() => setDragFrom(null)}
        />
      )}

      <div className="session-sidebar__footer">
        {collapsed && (
          <button
            type="button"
            className="session-sidebar__compact-new"
            title={msg.sidebar.newSessionHint(formatShortcut("Ctrl+Shift+N"))}
            aria-label={msg.sidebar.newSessionAria}
            onClick={() => onCreateSession()}
          >
            <IconPlus size={16} />
          </button>
        )}
        <UsageMeter
          session={sessions.find((session) => session.id === activeSessionId) ?? null}
          profiles={claudeProfiles}
          collapsed={collapsed}
        />
        <SystemResourceMeter collapsed={collapsed} />
      </div>

      {!collapsed && (
        <div
          className="session-sidebar__resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={msg.sidebar.resizeAria}
          title={msg.sidebar.resizeHint}
          onPointerDown={onResizePointerDown}
          onPointerMove={(event) => {
            const next = resizeTarget(event);
            if (next !== null) {
              setWidth(next);
            }
          }}
          onPointerUp={(event) => {
            const next = resizeTarget(event);
            if (next !== null) {
              finishResize(next);
            }
          }}
          onLostPointerCapture={() => {
            // Cancelado pelo sistema, sem pointerup: fica a última largura.
            if (resizeStart.current) {
              finishResize(width);
            }
          }}
          onDoubleClick={() => finishResize(SIDEBAR_WIDTH_DEFAULT)}
        />
      )}

      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          pinned={Boolean(contextMenu.session.pinned)}
          moveTargets={
            projectsEnabled
              ? projects.filter((project) => project.id !== contextMenu.session.projectId)
              : undefined
          }
          onMoveToProject={(projectId) => {
            useSessionStore.getState().moveSessionToProject(contextMenu.session.id, projectId);
            setContextMenu(null);
          }}
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
                  window.confirm(msg.sidebar.changeFolderConfirm)
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
          onHibernate={
            useSessionStore.getState().spawnedSessionIds[contextMenu.session.id]
              ? () => {
                  const { session } = contextMenu;
                  setContextMenu(null);
                  void hibernateSessionFromMenu(session.id);
                }
              : undefined
          }
          onClose={() => {
            void closeSessionWithWorktreeReview(contextMenu.session.id);
            setContextMenu(null);
          }}
        />
      )}
    </aside>
  );
}
