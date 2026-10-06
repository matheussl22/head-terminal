import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";

import { countTerminalStatuses } from "../../core/activity-utils";
import { confirmInApp } from "../../core/confirm-dialog";
import { basenamePath } from "../../core/path-utils";
import { useSessionStore } from "../../core/session-manager";
import { msg } from "../../i18n";
import type { AgentSession, Project } from "../../types/session";

export interface ProjectStats {
  count: number;
  waiting: number;
  working: number;
}

/** "3:1:0,0:0:0": sessions, waiting and working terminals per project, as a
 * string so the activity pings that change none of them don't re-render the
 * sidebar. */
export function useProjectStats(): ProjectStats[] {
  const key = useSessionStore((state) =>
    state.projects
      .map((project) => {
        const inProject = state.sessions.filter(
          (session) => session.projectId === project.id,
        );
        const { waiting, working } = countTerminalStatuses(
          inProject,
          state.paneRuntime,
          state.spawnedSessionIds,
        );
        return `${inProject.length}:${waiting}:${working}`;
      })
      .join(","),
  );
  return useMemo(
    () =>
      key
        ? key.split(",").map((entry) => {
            const [count, waiting, working] = entry.split(":").map(Number);
            return { count, waiting, working };
          })
        : [],
    [key],
  );
}

export function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
}

/** Closes a menu on a pointer down outside what `contains` accepts, or on
 * Escape. */
export function useDismiss(
  open: boolean,
  contains: (target: Node) => boolean,
  onDismiss: () => void,
): void {
  const latest = useRef({ contains, onDismiss });
  latest.current = { contains, onDismiss };
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!latest.current.contains(event.target as Node)) {
        latest.current.onDismiss();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        latest.current.onDismiss();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
}

/** A project name being typed: Enter or leaving the field keeps it, Esc
 * gives up — without closing the menu around it. */
export function ProjectNameInput({
  initialName = "",
  className,
  onCommit,
  onCancel,
}: {
  initialName?: string;
  className: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter and the blur that follows it must not create the project twice.
  const settled = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    if (settled.current) {
      return;
    }
    settled.current = true;
    const name = draft.trim().slice(0, 120);
    if (name && name !== initialName) {
      onCommit(name);
    } else {
      onCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      className={className}
      value={draft}
      maxLength={120}
      placeholder={msg.sidebar.projects.namePlaceholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          settled.current = true;
          onCancel();
        }
      }}
    />
  );
}

/** Rename, default folder and delete for one project: the switcher's menu
 * and a group header's. Only an empty project can go, never the last one. */
export function ProjectActionItems({
  project,
  sessionCount,
  onRename,
  onDone,
}: {
  project: Project;
  sessionCount: number;
  onRename: () => void;
  onDone: () => void;
}) {
  const projectCount = useSessionStore((state) => state.projects.length);
  const removeBlocked =
    projectCount <= 1
      ? msg.sidebar.projects.removeBlockedLast
      : sessionCount > 0
        ? msg.sidebar.projects.removeBlockedSessions
        : null;

  const chooseFolder = () => {
    onDone();
    void window.headTerminal.system
      .selectDirectory(project.cwd)
      .then((selected) => {
        if (typeof selected === "string" && selected) {
          useSessionStore.getState().setProjectCwd(project.id, selected);
        }
      })
      .catch(() => undefined);
  };

  const remove = async () => {
    onDone();
    const confirmed = await confirmInApp({
      title: msg.sidebar.projects.removeTitle(project.name),
      message: msg.sidebar.projects.removeMessage,
      confirmLabel: msg.sidebar.projects.removeConfirm,
      danger: true,
    });
    if (confirmed) {
      useSessionStore.getState().removeProject(project.id);
    }
  };

  return (
    <>
      <button type="button" onClick={onRename}>
        {msg.sidebar.projects.rename}
      </button>
      <button
        type="button"
        title={project.cwd ? msg.sidebar.projects.folderHint(project.cwd) : undefined}
        onClick={chooseFolder}
      >
        {msg.sidebar.projects.folder}
      </button>
      {project.cwd && (
        <button
          type="button"
          onClick={() => {
            onDone();
            useSessionStore.getState().setProjectCwd(project.id, undefined);
          }}
        >
          {msg.sidebar.projects.clearFolder}
        </button>
      )}
      <button
        type="button"
        className="session-context-menu__danger"
        disabled={removeBlocked !== null}
        title={removeBlocked ?? undefined}
        onClick={() => void remove()}
      >
        {msg.sidebar.projects.remove}
      </button>
    </>
  );
}

/**
 * Projects mode, one project at a time: the project on screen, and a menu to
 * switch to another one, create one, or rename, re-home or delete this one.
 * The badge counts the terminals waiting for the user in the other projects,
 * out of sight.
 */
export function ProjectSwitcher({ collapsed }: { collapsed: boolean }) {
  const projects = useSessionStore((state) => state.projects);
  const activeProjectId = useSessionStore((state) => state.activeProjectId);
  const stats = useProjectStats();
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const [editing, setEditing] = useState<"new" | "rename" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const open = menuStyle !== null;

  const close = () => {
    setMenuStyle(null);
    setEditing(null);
  };

  useDismiss(open, (target) => Boolean(rootRef.current?.contains(target)), close);

  const activeIndex = Math.max(
    0,
    projects.findIndex((project) => project.id === activeProjectId),
  );
  const active = projects[activeIndex];
  if (!active) {
    return null;
  }
  const activeStats = stats[activeIndex] ?? { count: 0, waiting: 0, working: 0 };
  const waitingElsewhere = stats.reduce(
    (sum, entry, index) => (index === activeIndex ? sum : sum + entry.waiting),
    0,
  );

  const toggleMenu = () => {
    if (open) {
      close();
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    // Fixed like the session context menu: the collapsed rail opens it to its
    // right, the full sidebar under the button and as wide as it.
    setMenuStyle(
      collapsed
        ? { left: rect.right + 6, top: rect.top, minWidth: 220 }
        : { left: rect.left, top: rect.bottom + 4, width: rect.width },
    );
  };

  return (
    <div
      ref={rootRef}
      className={collapsed ? "project-switcher project-switcher--collapsed" : "project-switcher"}
    >
      <button
        ref={buttonRef}
        type="button"
        className="project-switcher__current"
        title={msg.sidebar.projects.switcherHint(active.name)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggleMenu}
      >
        {collapsed ? (
          <span className="project-switcher__initial">{initialOf(active.name)}</span>
        ) : (
          <>
            <span className="project-switcher__name">{active.name}</span>
            <span className="project-switcher__caret" aria-hidden>
              ▾
            </span>
          </>
        )}
        {waitingElsewhere > 0 && (
          <span
            className="project-switcher__badge"
            title={msg.sidebar.projects.waiting(waitingElsewhere)}
          >
            {waitingElsewhere}
          </span>
        )}
      </button>

      {menuStyle && (
        <div
          className="session-context-menu project-switcher__menu"
          style={menuStyle}
          role="menu"
          aria-label={msg.sidebar.projects.menuAria}
        >
          {projects.map((project, index) => {
            const entry = stats[index] ?? { count: 0, waiting: 0, working: 0 };
            return (
              <button
                key={project.id}
                type="button"
                role="menuitemradio"
                aria-checked={project.id === active.id}
                className={
                  project.id === active.id
                    ? "project-switcher__item project-switcher__item--active"
                    : "project-switcher__item"
                }
                title={
                  project.cwd ? msg.sidebar.projects.folderHint(project.cwd) : undefined
                }
                onClick={() => {
                  close();
                  useSessionStore.getState().setActiveProjectId(project.id);
                }}
              >
                <span className="project-switcher__item-name">{project.name}</span>
                {entry.waiting > 0 && (
                  <span
                    className="project-switcher__item-waiting"
                    title={msg.sidebar.projects.waiting(entry.waiting)}
                  >
                    {entry.waiting}
                  </span>
                )}
                <span className="project-switcher__item-count">
                  {msg.sidebar.projects.sessionCount(entry.count)}
                </span>
              </button>
            );
          })}
          <div className="session-context-menu__separator" role="separator" />
          {editing ? (
            <ProjectNameInput
              className="project-switcher__input"
              initialName={editing === "rename" ? active.name : ""}
              onCommit={(name) => {
                const store = useSessionStore.getState();
                if (editing === "new") {
                  store.addProject(name);
                } else {
                  store.renameProject(active.id, name);
                }
                close();
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <>
              <button type="button" onClick={() => setEditing("new")}>
                {msg.sidebar.projects.newProject}
              </button>
              <ProjectActionItems
                project={active}
                sessionCount={activeStats.count}
                onRename={() => setEditing("rename")}
                onDone={close}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

const NEW_PROJECT_TARGET = "new";

/**
 * Projects mode, while a session is being dragged: the other projects it can
 * be dropped on, and a new one named after its folder. The session moves with
 * everything it has — its terminals keep running, nothing restarts.
 */
export function ProjectDropTargets({
  session,
  collapsed,
  onDropped,
}: {
  session: AgentSession;
  collapsed: boolean;
  onDropped: () => void;
}) {
  const projects = useSessionStore((state) => state.projects);
  const [over, setOver] = useState<string | null>(null);
  const targets = projects.filter((project) => project.id !== session.projectId);
  const folderName = basenamePath(session.cwd, session.title);

  const dropTarget = (id: string, move: () => void) => ({
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setOver(id);
    },
    onDragLeave: () => setOver((current) => (current === id ? null : current)),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setOver(null);
      move();
      onDropped();
    },
  });

  const targetClass = (id: string, extra = "") =>
    `project-drop__target${extra}${over === id ? " project-drop__target--over" : ""}`;

  return (
    <div
      className={collapsed ? "project-drop project-drop--collapsed" : "project-drop"}
      role="group"
      aria-label={msg.sidebar.projects.dropAria}
    >
      {!collapsed && (
        <span className="project-drop__label">{msg.sidebar.projects.dropLabel}</span>
      )}
      {targets.map((project) => (
        <div
          key={project.id}
          className={targetClass(project.id)}
          title={msg.sidebar.projects.dropOn(project.name)}
          {...dropTarget(project.id, () =>
            useSessionStore.getState().moveSessionToProject(session.id, project.id),
          )}
        >
          {collapsed ? initialOf(project.name) : project.name}
        </div>
      ))}
      <div
        className={targetClass(NEW_PROJECT_TARGET, " project-drop__target--new")}
        title={msg.sidebar.projects.dropNewHint(folderName)}
        {...dropTarget(NEW_PROJECT_TARGET, () => {
          const store = useSessionStore.getState();
          const projectId = store.addProject(folderName, session.cwd, { activate: false });
          store.moveSessionToProject(session.id, projectId);
        })}
      >
        {collapsed ? "+" : `+ ${msg.sidebar.projects.dropNew}`}
      </div>
    </div>
  );
}
