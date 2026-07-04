import { memo, useEffect, useRef, useState } from "react";

import { buildAgentProfiles } from "../../config/agents";
import { getSessionActivity } from "../../core/activity-utils";
import { pickGitContextForSession } from "../../core/git-context-utils";
import { collectPaneIds } from "../../core/session-layout";
import { useSessionStore } from "../../core/session-manager";
import {
  loadSidebarCollapsed,
  saveSidebarCollapsed,
} from "../../core/ui-preferences";
import { ACTIVITY_LABEL } from "../../types/activity";
import type { AgentSession } from "../../types/session";
import { GitBranchBadge } from "../ui/GitBranchBadge";
import { IconClose, IconPencil } from "../ui/Icons";

interface SessionSidebarProps {
  sessions: AgentSession[];
  onCreateSession: () => void;
  renameSessionId: string | null;
  onRenameComplete: () => void;
}

function sessionInitial(title: string): string {
  const trimmed = title.trim();
  return trimmed ? trimmed[0]?.toUpperCase() ?? "?" : "?";
}

// Profiles are static per run; hoisting avoids rebuilding them on every
// list-item render. Lazy so module import stays safe outside Tauri.
let cachedProfiles: Array<{ id: string; label: string }> | null = null;
function agentProfileOptions(): Array<{ id: string; label: string }> {
  cachedProfiles ??= Object.values(buildAgentProfiles()).map((profile) => ({
    id: profile.id,
    label: profile.label,
  }));
  return cachedProfiles;
}

interface SessionListItemProps {
  session: AgentSession;
  isActive: boolean;
  collapsed: boolean;
  forceRename: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onRemove: () => void;
  onAgentChange: (agentProfileId: string) => void;
  onCwdChange: (cwd: string) => void;
  onRenameComplete: () => void;
}

const SessionListItem = memo(function SessionListItem({
  session,
  isActive,
  collapsed,
  forceRename,
  onSelect,
  onRename,
  onRemove,
  onAgentChange,
  onCwdChange,
  onRenameComplete,
}: SessionListItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);
  const [draftCwd, setDraftCwd] = useState(session.cwd);
  const inputRef = useRef<HTMLInputElement>(null);
  const paneIds = collectPaneIds(session.layout);
  const paneCount = paneIds.length;
  // Narrow selectors: activity is a primitive and gitContext returns an
  // existing store object by reference, so ticks in other sessions don't
  // re-render this item.
  const activity = useSessionStore((state) =>
    getSessionActivity(session, state.paneRuntime),
  );
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
  const profiles = agentProfileOptions();

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
      // Changing cwd kills and respawns every pane in the session (§2.4).
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
    return (
      <li>
        <button
          type="button"
          className={
            isActive
              ? "session-sidebar__compact-item session-sidebar__compact-item--active"
              : "session-sidebar__compact-item"
          }
          title={`${session.title} — ${ACTIVITY_LABEL[activity]}${gitContext?.branch ? ` — ${gitContext.branch}` : ""}`}
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
          </div>

          <span className="session-sidebar__meta">{session.cwd}</span>
          <GitBranchBadge
            context={gitContext}
            className="session-sidebar__git-badge"
          />
          <span className="session-sidebar__status">
            {ACTIVITY_LABEL[activity]} · {paneCount} terminal
            {paneCount === 1 ? "" : "s"}
          </span>
        </button>

        {isActive && (
          <div className="session-sidebar__settings">
            <select
              className="session-sidebar__select-input"
              value={session.agentProfileId}
              onChange={(event) => {
                if (
                  window.confirm(
                    "Trocar o agent reinicia os terminais da sessão. Continuar?",
                  )
                ) {
                  onAgentChange(event.target.value);
                } else {
                  event.target.value = session.agentProfileId;
                }
              }}
              onClick={(event) => event.stopPropagation()}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}
                </option>
              ))}
            </select>

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
              className="session-sidebar__action session-sidebar__action--remove"
              title="Fechar sessão"
              aria-label={`Fechar ${session.title}`}
              onClick={(event) => {
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
}: SessionSidebarProps) {
  const [collapsed, setCollapsed] = useState(loadSidebarCollapsed);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const setActiveSessionId = useSessionStore((state) => state.setActiveSessionId);
  const renameSession = useSessionStore((state) => state.renameSession);
  const removeSession = useSessionStore((state) => state.removeSession);
  const updateSessionAgent = useSessionStore((state) => state.updateSessionAgent);
  const updateSessionCwd = useSessionStore((state) => state.updateSessionCwd);

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
            forceRename={renameSessionId === session.id}
            onSelect={() => setActiveSessionId(session.id)}
            onRename={(title) => renameSession(session.id, title)}
            onRemove={() => removeSession(session.id)}
            onAgentChange={(agentProfileId) =>
              updateSessionAgent(session.id, agentProfileId)
            }
            onCwdChange={(cwd) => updateSessionCwd(session.id, cwd)}
            onRenameComplete={onRenameComplete}
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
