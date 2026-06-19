import { useEffect, useRef, useState } from "react";

import { collectPaneIds } from "../../core/session-layout";
import { useSessionStore } from "../../core/session-manager";
import {
  loadSidebarCollapsed,
  saveSidebarCollapsed,
} from "../../core/ui-preferences";
import type { AgentSession, SessionStatus } from "../../types/session";

interface SessionSidebarProps {
  sessions: AgentSession[];
  onCreateSession: () => void;
}

function aggregateStatus(session: AgentSession): SessionStatus {
  const statuses = collectPaneIds(session.layout).map(
    (paneId) => session.paneStatuses[paneId] ?? "starting",
  );

  if (statuses.every((status) => status === "exited")) {
    return "exited";
  }

  if (statuses.some((status) => status === "running")) {
    return "running";
  }

  return "starting";
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: "Iniciando",
  running: "Ativo",
  exited: "Encerrado",
};

function RenameIcon() {
  return (
    <svg
      className="session-sidebar__rename-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function sessionInitial(title: string): string {
  const trimmed = title.trim();
  return trimmed ? trimmed[0]?.toUpperCase() ?? "?" : "?";
}

interface SessionListItemProps {
  session: AgentSession;
  isActive: boolean;
  collapsed: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
}

function SessionListItem({
  session,
  isActive,
  collapsed,
  onSelect,
  onRename,
}: SessionListItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const paneCount = collectPaneIds(session.layout).length;
  const status = aggregateStatus(session);

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
  };

  if (collapsed) {
    return (
      <li>
        <button
          type="button"
          className={
            isActive
              ? "session-sidebar__compact-item session-sidebar__compact-item--active"
              : "session-sidebar__compact-item"
          }
          title={session.title}
          aria-label={session.title}
          onClick={onSelect}
        >
          {sessionInitial(session.title)}
        </button>
      </li>
    );
  }

  return (
    <li>
      <div
        className={
          isActive
            ? "session-sidebar__item session-sidebar__item--active"
            : "session-sidebar__item"
        }
      >
        <button
          type="button"
          className="session-sidebar__select"
          onClick={onSelect}
        >
          <div className="session-sidebar__title-row">
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

            {!isEditing && (
              <button
                type="button"
                className="session-sidebar__rename"
                title="Renomear sessão"
                aria-label={`Renomear ${session.title}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setIsEditing(true);
                }}
              >
                <RenameIcon />
              </button>
            )}
          </div>

          <span className="session-sidebar__meta">{session.cwd}</span>
          <span className="session-sidebar__status">
            {STATUS_LABEL[status]} · {paneCount} terminal
            {paneCount === 1 ? "" : "s"}
          </span>
        </button>
      </div>
    </li>
  );
}

export function SessionSidebar({
  sessions,
  onCreateSession,
}: SessionSidebarProps) {
  const [collapsed, setCollapsed] = useState(loadSidebarCollapsed);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const setActiveSessionId = useSessionStore((state) => state.setActiveSessionId);
  const renameSession = useSessionStore((state) => state.renameSession);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      saveSidebarCollapsed(next);
      return next;
    });
  };

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
        {!collapsed && <span>Sessões</span>}

        <div className="session-sidebar__header-actions">
          {!collapsed && (
            <button
              type="button"
              className="session-sidebar__new"
              title="Nova sessão"
              onClick={onCreateSession}
            >
              + Nova
            </button>
          )}

          <button
            type="button"
            className="session-sidebar__toggle"
            title={collapsed ? "Expandir menu" : "Recolher menu"}
            aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
            onClick={toggleCollapsed}
          >
            {collapsed ? "»" : "«"}
          </button>
        </div>
      </div>

      <ul className="session-sidebar__list">
        {sessions.map((session) => (
          <SessionListItem
            key={session.id}
            session={session}
            collapsed={collapsed}
            isActive={session.id === activeSessionId}
            onSelect={() => setActiveSessionId(session.id)}
            onRename={(title) => renameSession(session.id, title)}
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
            +
          </button>
        </div>
      )}
    </aside>
  );
}
