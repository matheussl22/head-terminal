import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSession } from "../types/session";
import { collectPaneIds } from "./session-layout";
import { createEmptySession, sessionsInView, useSessionStore } from "./session-manager";

function shell(id: string, projectId?: string): AgentSession {
  return createEmptySession({
    id,
    title: id,
    cwd: "/tmp",
    agentProfileId: "shell",
    ...(projectId ? { projectId } : {}),
  });
}

function store() {
  return useSessionStore.getState();
}

function shownIds(): string[] {
  return sessionsInView(store()).map((session) => session.id);
}

describe("projects mode", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  it("is off by default and changes nothing: every session is shown, none gets a project", () => {
    expect(store().projectsEnabled).toBe(false);
    store().hydrateWorkspace([shell("a"), shell("b")], "a", null);
    store().addSession(shell("c"));

    expect(shownIds()).toEqual(["a", "b", "c"]);
    expect(store().sessions.every((session) => session.projectId === undefined)).toBe(true);
    expect(store().projects).toEqual([]);
  });

  it("puts the existing sessions in a first project when turned on, and remembers the setting", () => {
    store().hydrateWorkspace([shell("a"), shell("b")], "b", null);
    store().setProjectsEnabled(true);

    const [general] = store().projects;
    expect(store().projects).toHaveLength(1);
    expect(general.name).toBe("Geral");
    expect(store().sessions.map((session) => session.projectId)).toEqual([general.id, general.id]);
    expect(store().activeProjectId).toBe(general.id);
    expect(store().activeSessionId).toBe("b");
    expect(storage.get("head-terminal.projects.enabled")).toBe("1");
  });

  it("creates new sessions in the project on screen", () => {
    store().hydrateWorkspace([shell("a")], "a", null);
    store().setProjectsEnabled(true);
    const general = store().activeProjectId;

    const composer = store().addProject("Composer");
    expect(store().activeProjectId).toBe(composer);
    expect(store().activeSessionId).toBeNull();
    expect(shownIds()).toEqual([]);

    store().addSession(shell("api"));
    expect(store().sessions.find((session) => session.id === "api")?.projectId).toBe(composer);
    expect(shownIds()).toEqual(["api"]);

    store().setActiveProjectId(general!);
    expect(shownIds()).toEqual(["a"]);
  });

  it("follows a session into its project and comes back to the one each project showed", () => {
    store().hydrateWorkspace(
      [shell("a", "p1"), shell("b", "p1"), shell("c", "p2")],
      "a",
      null,
      {},
      {},
      {
        projects: [
          { id: "p1", name: "Composer" },
          { id: "p2", name: "Pessoal" },
        ],
        activeProjectId: "p1",
      },
    );
    store().setProjectsEnabled(true);

    store().setActiveSessionId("b");
    // A notification click or pane dot from the other project.
    store().setActiveSessionId("c");
    expect(store().activeProjectId).toBe("p2");
    expect(shownIds()).toEqual(["c"]);

    store().setActiveProjectId("p1");
    expect(store().activeSessionId).toBe("b");
    expect(store().spawnedSessionIds.b).toBe(true);
  });

  it("closing a session keeps the screen on its project, empty when it was the last one", () => {
    store().hydrateWorkspace(
      [shell("a", "p1"), shell("b", "p2"), shell("c", "p2")],
      "b",
      null,
      {},
      {},
      {
        projects: [
          { id: "p1", name: "Composer" },
          { id: "p2", name: "Pessoal" },
        ],
        activeProjectId: "p2",
      },
    );
    store().setProjectsEnabled(true);

    store().removeSession("b");
    expect(store().activeSessionId).toBe("c");
    expect(store().activeProjectId).toBe("p2");

    store().removeSession("c");
    expect(store().activeSessionId).toBeNull();
    expect(store().activePaneId).toBeNull();
    expect(store().activeProjectId).toBe("p2");
    expect(shownIds()).toEqual([]);
  });

  it("only deletes an empty project, never the last one", () => {
    store().hydrateWorkspace([shell("a")], "a", null);
    store().setProjectsEnabled(true);
    const general = store().activeProjectId!;

    expect(store().removeProject(general)).toBe(false);
    const empty = store().addProject("Vazio");
    expect(store().removeProject(general)).toBe(false);

    expect(store().removeProject(empty)).toBe(true);
    expect(store().projects.map((project) => project.id)).toEqual([general]);
    expect(store().activeProjectId).toBe(general);
    expect(store().activeSessionId).toBe("a");
  });

  it("moving the session on screen to another project leaves the screen where it was", () => {
    store().hydrateWorkspace([shell("a"), shell("b")], "a", null);
    store().setProjectsEnabled(true);
    const general = store().activeProjectId!;
    const other = store().addProject("Outro");
    store().setActiveProjectId(general);

    store().moveSessionToProject("a", other);
    expect(store().activeProjectId).toBe(general);
    expect(store().activeSessionId).toBe("b");

    store().moveSessionToProject("b", other);
    expect(store().activeProjectId).toBe(general);
    expect(store().activeSessionId).toBeNull();

    store().setActiveProjectId(other);
    expect(shownIds()).toEqual(["a", "b"]);
  });

  it("puts a moved session at the end of its new project's list", () => {
    store().hydrateWorkspace(
      [shell("a1", "p1"), shell("a2", "p1"), shell("b1", "p2")],
      "a1",
      null,
      {},
      {},
      {
        projects: [
          { id: "p1", name: "Alpha" },
          { id: "p2", name: "Beta" },
        ],
        activeProjectId: "p1",
      },
    );
    store().setProjectsEnabled(true);

    store().moveSessionToProject("a2", "p2");
    store().setActiveProjectId("p2");
    expect(shownIds()).toEqual(["b1", "a2"]);
  });

  it("drops a session into a new project without leaving the one on screen", () => {
    store().hydrateWorkspace([shell("a"), shell("b")], "a", null);
    store().setProjectsEnabled(true);
    const general = store().activeProjectId!;
    const runtimeBefore = store().paneRuntime;
    const layoutBefore = store().sessions.find((session) => session.id === "a")!.layout;

    // What dropping "a" on "+ Novo projeto" does.
    const created = store().addProject("tmp", "/tmp", { activate: false });
    store().moveSessionToProject("a", created);

    expect(store().projects.find((project) => project.id === created)).toMatchObject({
      name: "tmp",
      cwd: "/tmp",
    });
    expect(store().activeProjectId).toBe(general);
    expect(store().activeSessionId).toBe("b");
    // Everything goes with it: same session, same panes, nothing restarted.
    const moved = store().sessions.find((session) => session.id === "a")!;
    expect(moved.projectId).toBe(created);
    expect(moved.layout).toBe(layoutBefore);
    for (const paneId of collectPaneIds(moved.layout)) {
      expect(store().paneRuntime[paneId]).toBe(runtimeBefore[paneId]);
    }
  });

  it("keeps the projects when turned off, and finds them again when turned back on", () => {
    store().hydrateWorkspace([shell("a")], "a", null);
    store().setProjectsEnabled(true);
    const other = store().addProject("Outro");
    store().addSession(shell("b"));

    store().setProjectsEnabled(false);
    expect(shownIds()).toEqual(["a", "b"]);
    // Created while the mode is off: no project until it comes back on.
    store().addSession(shell("c"));
    expect(store().sessions.find((session) => session.id === "c")?.projectId).toBeUndefined();

    store().setProjectsEnabled(true);
    expect(store().projects).toHaveLength(2);
    expect(store().sessions.find((session) => session.id === "b")?.projectId).toBe(other);
    expect(store().sessions.find((session) => session.id === "c")?.projectId).toBe(
      store().activeProjectId,
    );
  });

  it("turned off on an empty project, shows a session again", () => {
    store().hydrateWorkspace([shell("a")], "a", null);
    store().setProjectsEnabled(true);
    store().addProject("Vazio");
    expect(store().activeSessionId).toBeNull();

    store().setProjectsEnabled(false);
    expect(store().activeSessionId).toBe("a");
    expect(store().activePaneId).toBe(collectPaneIds(store().sessions[0].layout)[0]);
  });

  it("loads a workspace in projects mode: unknown projects go to the one on screen, an empty one stays empty", () => {
    store().setProjectsEnabled(true);
    store().hydrateWorkspace(
      [shell("a", "p1"), shell("b", "deleted")],
      null,
      null,
      {},
      {},
      {
        projects: [
          { id: "p1", name: "Composer" },
          { id: "p2", name: "Vazio" },
        ],
        activeProjectId: "p2",
      },
    );
    expect(store().sessions.map((session) => session.projectId)).toEqual(["p1", "p2"]);
    expect(store().activeProjectId).toBe("p2");
    expect(store().activeSessionId).toBe("b");

    store().hydrateWorkspace(
      [shell("a", "p1")],
      null,
      null,
      {},
      {},
      {
        projects: [
          { id: "p1", name: "Composer" },
          { id: "p2", name: "Vazio" },
        ],
        activeProjectId: "p2",
      },
    );
    expect(store().activeProjectId).toBe("p2");
    expect(store().activeSessionId).toBeNull();
  });
});

describe("projects mode, grouped view", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
    store().hydrateWorkspace(
      [shell("b1", "p2"), shell("a1", "p1"), shell("a2", "p1"), shell("c1", "p3")],
      "a1",
      null,
      {},
      {},
      {
        projects: [
          { id: "p1", name: "Alpha" },
          { id: "p2", name: "Beta" },
          { id: "p3", name: "Gamma", collapsed: true },
        ],
        activeProjectId: "p1",
      },
    );
    store().setProjectsEnabled(true);
    store().setProjectsView("grouped");
  });

  it("goes through the sessions project by project, without the folded ones", () => {
    expect(shownIds()).toEqual(["a1", "a2", "b1"]);

    store().toggleProjectCollapsed("p2");
    expect(shownIds()).toEqual(["a1", "a2"]);
    store().toggleProjectCollapsed("p3");
    expect(shownIds()).toEqual(["a1", "a2", "c1"]);
    expect(store().projects.find((project) => project.id === "p3")).not.toHaveProperty(
      "collapsed",
    );
  });

  it("unfolds the project of a session taking the screen", () => {
    store().setActiveSessionId("c1");
    expect(store().projects.find((project) => project.id === "p3")?.collapsed).toBeUndefined();
    expect(store().activeProjectId).toBe("p3");
  });

  it("closing a project's last session hands the screen to another project's", () => {
    store().setActiveSessionId("b1");
    store().removeSession("b1");
    expect(store().activeSessionId).toBe("a1");
    expect(store().activeProjectId).toBe("p1");
  });

  it("moving the session on screen keeps it there, under its new header", () => {
    store().moveSessionToProject("a1", "p3");
    expect(store().activeSessionId).toBe("a1");
    expect(store().activeProjectId).toBe("p3");
    expect(store().projects.find((project) => project.id === "p3")?.collapsed).toBeUndefined();
    expect(shownIds()).toEqual(["a2", "b1", "c1", "a1"]);
  });

  it("does not fold away the session on screen when switching to the grouped view", () => {
    store().setProjectsView("single");
    store().toggleProjectCollapsed("p1");
    store().setProjectsView("grouped");
    expect(store().projects.find((project) => project.id === "p1")?.collapsed).toBeUndefined();
    expect(localStorage.getItem("head-terminal.projects.view")).toBe("grouped");
  });
});
