import { useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";

import { useSessionStore } from "../../core/session-manager";
import { msg } from "../../i18n";
import type { AgentSession } from "../../types/session";
import { IconChevronDown, IconMore, IconPlus } from "../ui/Icons";
import {
  ProjectActionItems,
  ProjectNameInput,
  initialOf,
  useDismiss,
  useProjectStats,
} from "./ProjectSwitcher";

interface ProjectGroupsProps {
  /** The sessions to list, already narrowed by the profile chips. */
  sessions: AgentSession[];
  /** A profile chip is on: a project with none of its sessions is left out. */
  filtering: boolean;
  /** The sidebar's collapsed rail. */
  collapsed: boolean;
  /** The session being dragged, which a project header takes in. */
  dragSession: AgentSession | null;
  onDropSession: (projectId: string) => void;
  onCreateSession: (projectId: string) => void;
  renderSession: (session: AgentSession) => ReactNode;
}

/**
 * Projects mode, grouped view: every project in the sidebar as a tree — a
 * header that folds its sessions away, shows its numbers, starts a session in
 * it or opens its actions, and takes in a session dropped on it.
 */
export function ProjectGroups({
  sessions,
  filtering,
  collapsed,
  dragSession,
  onDropSession,
  onCreateSession,
  renderSession,
}: ProjectGroupsProps) {
  const projects = useSessionStore((state) => state.projects);
  const activeProjectId = useSessionStore((state) => state.activeProjectId);
  const stats = useProjectStats();
  const [menu, setMenu] = useState<{ projectId: string; style: CSSProperties } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [dropOver, setDropOver] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The ⋯ button that opened the menu counts as inside it: pressing it again
  // closes the menu instead of closing and reopening it.
  useDismiss(
    menu !== null,
    (target) =>
      Boolean(menuRef.current?.contains(target)) ||
      Boolean(
        target instanceof Element &&
          menu &&
          target.closest(`[data-project-menu="${menu.projectId}"]`),
      ),
    () => setMenu(null),
  );

  const toggleMenu = (projectId: string, anchor: HTMLElement) => {
    if (menu?.projectId === projectId) {
      setMenu(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    setMenu({ projectId, style: { left: rect.left, top: rect.bottom + 4, minWidth: 210 } });
  };

  const menuIndex = menu ? projects.findIndex((project) => project.id === menu.projectId) : -1;
  const menuProject = menuIndex >= 0 ? projects[menuIndex] : null;

  return (
    <div className="project-groups" role="list" aria-label={msg.sidebar.projects.menuAria}>
      {projects.map((project, index) => {
        const inGroup = sessions.filter((session) => session.projectId === project.id);
        if (filtering && inGroup.length === 0) {
          return null;
        }
        const entry = stats[index] ?? { count: 0, waiting: 0, working: 0 };
        const folded = Boolean(project.collapsed);
        const takesDrop = dragSession !== null && dragSession.projectId !== project.id;
        const headerClass = [
          "project-group__header",
          project.id === activeProjectId && "project-group__header--active",
          menu?.projectId === project.id && "project-group__header--menu",
          dropOver === project.id && "project-group__header--drop",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <section
            key={project.id}
            role="listitem"
            className={folded ? "project-group project-group--folded" : "project-group"}
          >
            <div
              className={headerClass}
              onDragOver={
                takesDrop
                  ? (event: DragEvent) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropOver(project.id);
                    }
                  : undefined
              }
              onDragLeave={() =>
                setDropOver((current) => (current === project.id ? null : current))
              }
              onDrop={
                takesDrop
                  ? (event: DragEvent) => {
                      event.preventDefault();
                      setDropOver(null);
                      onDropSession(project.id);
                    }
                  : undefined
              }
            >
              {renaming === project.id ? (
                <ProjectNameInput
                  className="project-group__rename"
                  initialName={project.name}
                  onCommit={(name) => {
                    useSessionStore.getState().renameProject(project.id, name);
                    setRenaming(null);
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <button
                  type="button"
                  className="project-group__toggle"
                  aria-expanded={!folded}
                  title={
                    folded
                      ? msg.sidebar.projects.expandHint(project.name)
                      : msg.sidebar.projects.collapseHint(project.name)
                  }
                  onClick={() => useSessionStore.getState().toggleProjectCollapsed(project.id)}
                >
                  {collapsed ? (
                    <>
                      <span className="project-group__initial">{initialOf(project.name)}</span>
                      {entry.waiting > 0 && (
                        <span
                          className="project-group__signal project-group__signal--waiting project-group__signal--corner"
                          title={msg.sidebar.waitingCount(entry.waiting)}
                        >
                          {entry.waiting}
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <IconChevronDown size={12} className="project-group__chevron" />
                      <span className="project-group__name">{project.name}</span>
                    </>
                  )}
                </button>
              )}
              {!collapsed && renaming !== project.id && (
                <>
                  <span className="project-group__meta">
                    {entry.waiting > 0 && (
                      <span
                        className="project-group__signal project-group__signal--waiting"
                        title={msg.sidebar.waitingCount(entry.waiting)}
                      >
                        {entry.waiting}
                      </span>
                    )}
                    {entry.working > 0 && (
                      <span
                        className="project-group__signal project-group__signal--working"
                        title={msg.sidebar.workingCount(entry.working)}
                      >
                        {entry.working}
                      </span>
                    )}
                    <span
                      className="project-group__count"
                      title={msg.sidebar.projects.sessionCount(entry.count)}
                    >
                      {entry.count}
                    </span>
                  </span>
                  <span className="project-group__actions">
                    <button
                      type="button"
                      className="project-group__action"
                      title={msg.sidebar.projects.newSessionIn(project.name)}
                      aria-label={msg.sidebar.projects.newSessionIn(project.name)}
                      onClick={() => onCreateSession(project.id)}
                    >
                      <IconPlus size={13} />
                    </button>
                    <button
                      type="button"
                      className="project-group__action"
                      data-project-menu={project.id}
                      title={msg.sidebar.projects.actionsAria(project.name)}
                      aria-label={msg.sidebar.projects.actionsAria(project.name)}
                      aria-haspopup="menu"
                      aria-expanded={menu?.projectId === project.id}
                      onClick={(event) => toggleMenu(project.id, event.currentTarget)}
                    >
                      <IconMore size={14} />
                    </button>
                  </span>
                </>
              )}
            </div>
            {!folded &&
              (inGroup.length > 0 ? (
                <ul className="session-sidebar__list project-group__list">
                  {inGroup.map(renderSession)}
                </ul>
              ) : (
                !collapsed && (
                  <div className="project-group__empty">
                    <span>{msg.sidebar.projects.groupEmpty}</span>
                    <button
                      type="button"
                      className="project-group__empty-action"
                      onClick={() => onCreateSession(project.id)}
                    >
                      <IconPlus size={11} />
                      <span>{msg.sidebar.projects.newSessionHere}</span>
                    </button>
                  </div>
                )
              ))}
          </section>
        );
      })}

      {!collapsed &&
        (creatingProject ? (
          <ProjectNameInput
            className="project-group__rename project-groups__new-input"
            onCommit={(name) => {
              useSessionStore.getState().addProject(name, undefined, { activate: false });
              setCreatingProject(false);
            }}
            onCancel={() => setCreatingProject(false)}
          />
        ) : (
          <button
            type="button"
            className="project-groups__new"
            onClick={() => setCreatingProject(true)}
          >
            <IconPlus size={12} />
            <span>{msg.sidebar.projects.newProject}</span>
          </button>
        ))}

      {menu && menuProject && (
        <div
          ref={menuRef}
          className="session-context-menu project-switcher__menu"
          style={menu.style}
          role="menu"
          aria-label={msg.sidebar.projects.actionsAria(menuProject.name)}
        >
          <button
            type="button"
            onClick={() => {
              setMenu(null);
              onCreateSession(menuProject.id);
            }}
          >
            {msg.sidebar.projects.newSessionHere}
          </button>
          <div className="session-context-menu__separator" role="separator" />
          <ProjectActionItems
            project={menuProject}
            sessionCount={stats[menuIndex]?.count ?? 0}
            onRename={() => {
              setMenu(null);
              setRenaming(menuProject.id);
            }}
            onDone={() => setMenu(null)}
          />
        </div>
      )}
    </div>
  );
}
