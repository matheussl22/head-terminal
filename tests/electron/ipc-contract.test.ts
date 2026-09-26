import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const handles = new Map<string, (...args: unknown[]) => unknown>();
  const listeners = new Map<string, (...args: unknown[]) => unknown>();

  class Notification {
    static isSupported = vi.fn(() => true);
    static instances: Notification[] = [];
    on = vi.fn();
    show = vi.fn();
    constructor() {
      Notification.instances.push(this);
    }
  }

  // The preload's side: an EventEmitter's on/removeListener, and a way for
  // the test to play main sending on a channel.
  type RendererListener = (event: unknown, payload: unknown) => void;
  const rendererListeners = new Map<string, RendererListener[]>();
  const listenersOf = (channel: string) => {
    let list = rendererListeners.get(channel);
    if (!list) {
      list = [];
      rendererListeners.set(channel, list);
    }
    return list;
  };
  const ipcRenderer = {
    on: vi.fn((channel: string, listener: RendererListener) => {
      listenersOf(channel).push(listener);
      return ipcRenderer;
    }),
    removeListener: vi.fn((channel: string, listener: RendererListener) => {
      const list = listenersOf(channel);
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
      return ipcRenderer;
    }),
    invoke: vi.fn(),
    send: vi.fn(),
    listenerCount: (channel: string) => listenersOf(channel).length,
    emit: (channel: string, payload: unknown) => {
      for (const listener of [...listenersOf(channel)]) listener({}, payload);
    },
    reset: () => rendererListeners.clear(),
  };
  const exposed: Record<string, unknown> = {};

  return {
    handles,
    listeners,
    ipcRenderer,
    exposed,
    contextBridge: {
      exposeInMainWorld: vi.fn((key: string, api: unknown) => {
        exposed[key] = api;
      }),
    },
    app: {
      isPackaged: false,
      getVersion: vi.fn(() => "0.1.0-test"),
      getPath: vi.fn(() => "/tmp/head-terminal-test"),
    },
    clipboard: {
      readText: vi.fn(() => "clipboard value"),
      writeText: vi.fn(),
      readImage: vi.fn(() => ({
        isEmpty: () => true,
        getSize: () => ({ width: 0, height: 0 }),
        toPNG: () => Buffer.alloc(0),
      })),
      availableFormats: vi.fn(() => ["text/plain"]),
      read: vi.fn(() => ""),
      readBuffer: vi.fn(() => Buffer.alloc(0)),
    },
    ipcMain: {
      handle: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
        handles.set(channel, listener);
      }),
      on: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
        listeners.set(channel, listener);
      }),
      removeHandler: vi.fn((channel: string) => handles.delete(channel)),
      removeListener: vi.fn((channel: string) => listeners.delete(channel)),
    },
    Notification,
  };
});

vi.mock("electron", () => ({
  app: electron.app,
  clipboard: electron.clipboard,
  ipcMain: electron.ipcMain,
  Notification: electron.Notification,
  contextBridge: electron.contextBridge,
  ipcRenderer: electron.ipcRenderer,
  webUtils: { getPathForFile: vi.fn(() => "") },
}));

import { IPC_CHANNELS } from "../../electron/ipc/channels";
import { registerIpc, type IpcServices } from "../../electron/ipc/register";
import type { HeadTerminalApi, PtyDataEvent } from "../../electron/types/api";

interface FakeWindowHarness {
  window: Parameters<typeof registerIpc>[0]["window"];
  trustedEvent: { sender: unknown; senderFrame: unknown };
  foreignEvent: { sender: unknown; senderFrame: unknown };
  sent: Array<[string, unknown]>;
}

function fakeWindow(): FakeWindowHarness {
  const mainFrame = {};
  const sent: Array<[string, unknown]> = [];
  const webContents = {
    id: 73,
    mainFrame,
    isDestroyed: vi.fn(() => false),
    send: vi.fn((channel: string, payload: unknown) => sent.push([channel, payload])),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  };
  const window = {
    webContents,
    setTitle: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };

  return {
    window: window as unknown as FakeWindowHarness["window"],
    trustedEvent: { sender: webContents, senderFrame: mainFrame },
    foreignEvent: {
      sender: { ...webContents, id: 999 },
      senderFrame: {},
    },
    sent,
  };
}

function flattenChannels(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Object.values(value as Record<string, unknown>).flatMap(flattenChannels);
}

function invoke(channel: string, event: unknown, ...args: unknown[]): unknown {
  const handler = electron.handles.get(channel);
  if (!handler) throw new Error(`Missing invoke handler for ${channel}`);
  return handler(event, ...args);
}

function send(channel: string, event: unknown, ...args: unknown[]): unknown {
  const listener = electron.listeners.get(channel);
  if (!listener) throw new Error(`Missing event listener for ${channel}`);
  return listener(event, ...args);
}

beforeEach(() => {
  electron.handles.clear();
  electron.listeners.clear();
  electron.Notification.instances.length = 0;
  vi.clearAllMocks();
});

describe("Electron IPC contract", () => {
  it("uses globally unique, capability-scoped channel names", () => {
    const channels = flattenChannels(IPC_CHANNELS);

    expect(new Set(channels).size).toBe(channels.length);
    expect(channels).toHaveLength(64);
    expect(channels.every((channel) => /^[a-z][a-z-]*:[a-z][a-z-]*$/.test(channel))).toBe(true);
  });

  it("registers every renderer request channel and no generic IPC escape hatch", () => {
    const harness = fakeWindow();
    const remove = registerIpc({ window: harness.window });
    const mainToRendererOnly = new Set([
      IPC_CHANNELS.app.closeRequested,
      IPC_CHANNELS.terminal.data,
      IPC_CHANNELS.terminal.exit,
      IPC_CHANNELS.git.changed,
      IPC_CHANNELS.notifications.activated,
      IPC_CHANNELS.live.toggleRequested,
      IPC_CHANNELS.live.endRequested,
      IPC_CHANNELS.live.delegationProgress,
      IPC_CHANNELS.agentHooks.event,
    ]);
    const expected = flattenChannels(IPC_CHANNELS).filter(
      (channel) => !mainToRendererOnly.has(channel),
    );
    const registered = [...electron.handles.keys(), ...electron.listeners.keys()];

    expect(new Set(registered)).toEqual(new Set(expected));
    expect(registered.some((channel) => /(^|:)(invoke|send|execute)$/.test(channel))).toBe(false);

    remove();
    expect(electron.handles.size).toBe(0);
    expect(electron.listeners.size).toBe(0);
  });

  it("routes a validated PTY spawn to the owner WebContents", async () => {
    const harness = fakeWindow();
    const spawn = vi.fn(() => ({ id: "pane-1", pid: 321 }));
    const services: IpcServices = {
      terminal: {
        spawn,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      },
    };
    registerIpc({ window: harness.window, services });
    const input = {
      id: "pane-1",
      command: "/bin/zsh",
      args: ["-l"],
      cwd: "/tmp",
      cols: 100,
      rows: 30,
      env: { LANG: "pt_BR.UTF-8" },
    };

    expect(
      await invoke(IPC_CHANNELS.terminal.spawn, harness.trustedEvent, input),
    ).toEqual({ id: "pane-1", pid: 321 });
    expect(spawn).toHaveBeenCalledWith(73, input);
  });

  it("lets the pane id through to the PTY env, and only a well-formed one", async () => {
    const harness = fakeWindow();
    const spawn = vi.fn(() => ({ id: "pane-1", pid: 321 }));
    registerIpc({
      window: harness.window,
      services: { terminal: { spawn, write: vi.fn(), resize: vi.fn(), kill: vi.fn() } },
    });
    const base = { id: "pane-1", command: "/bin/zsh", args: ["-l"], cwd: "/tmp", cols: 100, rows: 30 };
    const paneId = "0d4c9a51-7f39-4a8e-9b0e-2d6f1c3e5a77";

    await invoke(IPC_CHANNELS.terminal.spawn, harness.trustedEvent, {
      ...base,
      env: { CLAUDE_CONFIG_DIR: "/home/me/.claude-x", HT_PANE_ID: paneId },
    });
    expect(spawn).toHaveBeenLastCalledWith(73, expect.objectContaining({
      env: { CLAUDE_CONFIG_DIR: "/home/me/.claude-x", HT_PANE_ID: paneId },
    }));

    // A malformed id costs the pane its hooks, not its spawn.
    await invoke(IPC_CHANNELS.terminal.spawn, harness.trustedEvent, {
      ...base,
      env: { HT_PANE_ID: "x\r\nInjected: 1", LANG: "pt_BR.UTF-8" },
    });
    expect(spawn).toHaveBeenLastCalledWith(73, expect.objectContaining({
      env: { LANG: "pt_BR.UTF-8" },
    }));

    // The allowlist still holds for everything else.
    expect(() =>
      invoke(IPC_CHANNELS.terminal.spawn, harness.trustedEvent, {
        ...base,
        env: { HT_PANE_ID: paneId, NODE_OPTIONS: "--require /tmp/x.js" },
      }),
    ).toThrow(/not allowed/);
  });

  it("hands out one pane's Claude hook settings, or null without a hook server", async () => {
    const harness = fakeWindow();
    const paneId = "0d4c9a51-7f39-4a8e-9b0e-2d6f1c3e5a77";
    registerIpc({ window: harness.window });
    expect(
      await invoke(IPC_CHANNELS.agentHooks.getClaudeSettings, harness.trustedEvent, paneId),
    ).toBeNull();

    const settings = { settingsPath: `/data/agent-hooks/panes/${paneId}.json` };
    const getClaudeSettings = vi.fn(async (_paneId: string) => settings);
    registerIpc({
      window: harness.window,
      services: {
        agentHooks: { getClaudeSettings, onEvent: vi.fn(() => vi.fn()) },
      },
    });
    expect(
      await invoke(IPC_CHANNELS.agentHooks.getClaudeSettings, harness.trustedEvent, paneId),
    ).toEqual(settings);
    expect(getClaudeSettings).toHaveBeenCalledWith(paneId);
    expect(() =>
      invoke(IPC_CHANNELS.agentHooks.getClaudeSettings, harness.foreignEvent, paneId),
    ).toThrow(/untrusted frame/);
  });

  it("validates the pane id before it can name a file or a header", async () => {
    const harness = fakeWindow();
    const getClaudeSettings = vi.fn(async () => ({ settingsPath: "/x.json" }));
    registerIpc({
      window: harness.window,
      services: { agentHooks: { getClaudeSettings, onEvent: vi.fn(() => vi.fn()) } },
    });

    for (const value of [undefined, 42, ""]) {
      expect(() =>
        invoke(IPC_CHANNELS.agentHooks.getClaudeSettings, harness.trustedEvent, value),
      ).toThrow(/paneId/);
    }
    // A malformed id costs the pane its hooks, not its spawn.
    for (const value of ["../../evil", "a\r\nInjected: 1", "$HT_PANE_ID", "x".repeat(65)]) {
      expect(
        await invoke(IPC_CHANNELS.agentHooks.getClaudeSettings, harness.trustedEvent, value),
      ).toBeNull();
    }
    expect(getClaudeSettings).not.toHaveBeenCalled();
  });

  it("forwards hook events to the window and stops when unregistered", () => {
    const harness = fakeWindow();
    let emit: ((payload: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const remove = registerIpc({
      window: harness.window,
      services: {
        agentHooks: {
          getClaudeSettings: vi.fn(async () => null),
          onEvent: vi.fn((listener) => {
            emit = listener as (payload: unknown) => void;
            return unsubscribe;
          }),
        },
      },
    });
    const payload = {
      paneId: "0d4c9a51-7f39-4a8e-9b0e-2d6f1c3e5a77",
      source: "claude",
      event: "PermissionRequest",
      toolName: "Write",
      sessionId: "3f2c1a9e-7b4d-4e21-9c55-0a1b2c3d4e5f",
      receivedAt: 1,
    };
    emit?.(payload);
    expect(harness.sent).toEqual([[IPC_CHANNELS.agentHooks.event, payload]]);

    remove();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  // Review store-hooks-ui-fixes#1: with the window brought back first, the
  // renderer's focus listener read the "Concluído" of the pane that was
  // active before the click could say which pane it was about.
  it("says which pane a clicked notification is about before bringing the window back", async () => {
    const harness = fakeWindow();
    const order: string[] = [];
    const win = harness.window as unknown as Record<
      "isMinimized" | "restore" | "show" | "focus",
      ReturnType<typeof vi.fn>
    >;
    win.isMinimized.mockReturnValue(true);
    for (const name of ["restore", "show", "focus"] as const) {
      win[name].mockImplementation(() => order.push(name));
    }
    vi.mocked(harness.window.webContents.send).mockImplementation((channel: string) => {
      order.push(channel);
    });
    registerIpc({ window: harness.window });

    await invoke(IPC_CHANNELS.notifications.show, harness.trustedEvent, {
      title: "Head Terminal",
      body: "web: cc2 concluiu",
      sessionId: "s2",
      paneId: "p-b",
    });
    const [notification] = electron.Notification.instances;
    expect(notification.show).toHaveBeenCalledOnce();
    const onClick = notification.on.mock.calls.find(([name]) => name === "click")?.[1] as () => void;
    onClick();

    expect(order).toEqual([IPC_CHANNELS.notifications.activated, "restore", "show", "focus"]);
    expect(harness.window.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.notifications.activated,
      { sessionId: "s2", paneId: "p-b" },
    );

    // Without a session to land on it still brings the window back.
    order.length = 0;
    win.isMinimized.mockReturnValue(false);
    await invoke(IPC_CHANNELS.notifications.show, harness.trustedEvent, {
      title: "Head Terminal",
      body: "algo",
    });
    const plain = electron.Notification.instances[1];
    (plain.on.mock.calls.find(([name]) => name === "click")?.[1] as () => void)();
    expect(order).toEqual(["show", "focus"]);
  });

  it("accepts a PowerShell pane with the fixed switch set and an encoded script", async () => {
    const harness = fakeWindow();
    const spawn = vi.fn(() => ({ id: "pane-1", pid: 321 }));
    const services: IpcServices = {
      terminal: { spawn, write: vi.fn(), resize: vi.fn(), kill: vi.fn() },
    };
    registerIpc({ window: harness.window, services });
    const input = {
      id: "pane-1",
      command: "powershell",
      args: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-EncodedCommand", "VwByAGkAdABlAC0ASABvAHMAdAA="],
      cwd: "C:\\Users\\m",
      cols: 100,
      rows: 30,
    };

    expect(
      await invoke(IPC_CHANNELS.terminal.spawn, harness.trustedEvent, input),
    ).toEqual({ id: "pane-1", pid: 321 });
    expect(spawn).toHaveBeenCalledWith(73, input);
  });

  it("rejects PowerShell switches the renderer never builds", () => {
    const harness = fakeWindow();
    const spawn = vi.fn();
    registerIpc({
      window: harness.window,
      services: { terminal: { spawn, write: vi.fn(), resize: vi.fn(), kill: vi.fn() } },
    });
    const base = { id: "pane-1", command: "powershell", cwd: "C:\\Users\\m", cols: 100, rows: 30 };

    // A plain-text -Command would let anything through the argv join.
    expect(() =>
      invoke(IPC_CHANNELS.terminal.spawn, harness.trustedEvent, {
        ...base,
        args: ["-NoExit", "-Command", "Remove-Item -Recurse C:\\"],
      }),
    ).toThrow(/args/);
    // A script not announced by -EncodedCommand.
    expect(() =>
      invoke(IPC_CHANNELS.terminal.spawn, harness.trustedEvent, {
        ...base,
        args: ["-NoLogo", "VwByAGkAdABlAC0ASABvAHMAdAA="],
      }),
    ).toThrow(/args/);
    // Neither shell.
    expect(() =>
      invoke(IPC_CHANNELS.terminal.spawn, harness.trustedEvent, {
        ...base,
        command: "cmd.exe",
        args: [],
      }),
    ).toThrow(/approved shell/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("accepts a WSL pane only as `wsl -d <distro>`", async () => {
    const harness = fakeWindow();
    const spawn = vi.fn(() => ({ id: "pane-1", pid: 321 }));
    registerIpc({
      window: harness.window,
      services: { terminal: { spawn, write: vi.fn(), resize: vi.fn(), kill: vi.fn() } },
    });
    const base = { id: "pane-1", command: "wsl", cwd: "C:\\Users\\m", cols: 100, rows: 30 };

    const input = { ...base, args: ["-d", "Ubuntu-24.04"] };
    expect(
      await invoke(IPC_CHANNELS.terminal.spawn, harness.trustedEvent, input),
    ).toEqual({ id: "pane-1", pid: 321 });
    expect(spawn).toHaveBeenCalledWith(73, input);

    for (const args of [
      [],
      ["-d", "Ubuntu", "--exec", "rm", "-rf", "/"],
      ["-e", "rm -rf /"],
      ["-d", "Ubuntu;rm"],
      ["-u", "root"],
    ]) {
      expect(() =>
        invoke(IPC_CHANNELS.terminal.spawn, harness.trustedEvent, { ...base, args }),
      ).toThrow(/args/);
    }
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed PTY, secret and workspace payloads before services run", () => {
    const harness = fakeWindow();
    const services: IpcServices = {
      terminal: {
        spawn: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      },
      secrets: {
        has: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        getBackendStatus: vi.fn(),
      },
      workspace: {
        load: vi.fn(),
        save: vi.fn(),
      },
    };
    registerIpc({ window: harness.window, services });

    expect(() =>
      invoke(IPC_CHANNELS.terminal.spawn, harness.trustedEvent, {
        id: "pane-1",
        command: "/bin/sh",
        args: [],
        cwd: "/tmp",
        cols: 0,
        rows: 24,
      }),
    ).toThrow(/cols/);
    expect(() =>
      invoke(IPC_CHANNELS.secrets.has, harness.trustedEvent, "arbitrary-secret"),
    ).toThrow(/not allowed/);
    expect(() =>
      invoke(IPC_CHANNELS.workspace.save, harness.trustedEvent, {
        version: 99,
        sessions: [],
      }),
    ).toThrow(/version/);
    expect(services.terminal?.spawn).not.toHaveBeenCalled();
    expect(services.secrets?.has).not.toHaveBeenCalled();
    expect(services.workspace?.save).not.toHaveBeenCalled();
  });

  it("validates the pane conversation a voice session asks to pick up", async () => {
    const harness = fakeWindow();
    const createSession = vi.fn(async () => ({ sessionId: null, sdp: "answer" }));
    registerIpc({
      window: harness.window,
      services: {
        live: { createSession, delegate: vi.fn(), cancelDelegation: vi.fn(async () => undefined) },
      },
    });
    const base = { sdp: "offer", cwd: "/tmp/project", agent: "claude" };

    // The id becomes a file name under the profile's transcripts.
    expect(() =>
      invoke(IPC_CHANNELS.live.createSession, harness.trustedEvent, {
        ...base,
        paneConversation: { agent: "claude", sessionId: "../../etc/passwd" },
      }),
    ).toThrow(/session id/);
    expect(() =>
      invoke(IPC_CHANNELS.live.createSession, harness.trustedEvent, {
        ...base,
        paneConversation: { agent: "cursor", sessionId: "04bb555b-b7ca-41bd-823f-468ff79b7783" },
      }),
    ).toThrow(/agent/);
    expect(createSession).not.toHaveBeenCalled();

    const paneConversation = {
      agent: "claude",
      sessionId: "04bb555b-b7ca-41bd-823f-468ff79b7783",
      claudeConfigDir: "/home/me/.head-terminal/claude-profiles/default",
    };
    await invoke(IPC_CHANNELS.live.createSession, harness.trustedEvent, { ...base, paneConversation });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ ...base, branch: null, resumeNote: null, paneConversation }),
    );
  });

  it("validates brainstorm delegations before an agent runs", async () => {
    const harness = fakeWindow();
    const delegate = vi.fn(async () => ({ summary: "s", details: "d", agentSessionId: null }));
    registerIpc({
      window: harness.window,
      services: {
        live: {
          createSession: vi.fn(),
          delegate,
          cancelDelegation: vi.fn(async () => undefined),
        },
      },
    });
    const base = {
      delegationId: "item_1",
      agent: "claude",
      cwd: "/tmp/project",
      transcript: "Usuário: olha o upload",
      claudeConfigDir: "/home/me/.head-terminal/claude-profiles/default",
    };

    expect(() =>
      invoke(IPC_CHANNELS.live.delegate, harness.trustedEvent, { ...base, agent: "ollama" }),
    ).toThrow(/agent/);
    // A resume id lands on the agent's command line: nothing but an id passes.
    expect(() =>
      invoke(IPC_CHANNELS.live.delegate, harness.trustedEvent, {
        ...base,
        resume: { sessionId: "abc; rm -rf /", fork: true },
      }),
    ).toThrow(/session id/);
    expect(delegate).not.toHaveBeenCalled();

    const resume = { sessionId: "04bb555b-b7ca-41bd-823f-468ff79b7783", fork: true };
    await invoke(IPC_CHANNELS.live.delegate, harness.trustedEvent, { ...base, resume });
    expect(delegate).toHaveBeenCalledWith(73, { ...base, resume }, expect.any(Function));

    // The agent's steps stream back to the renderer tagged with the delegation.
    const onProgress = delegate.mock.calls[0]?.[2] as (event: unknown) => void;
    onProgress({ text: "lendo api.ts" });
    expect(harness.sent).toContainEqual([
      IPC_CHANNELS.live.delegationProgress,
      { delegationId: "item_1", text: "lendo api.ts" },
    ]);

    expect(() =>
      invoke(IPC_CHANNELS.live.delegate, harness.trustedEvent, {
        ...base,
        attachments: new Array(9).fill("C:/shot.png"),
      }),
    ).toThrow(/attachments/);
  });

  it("forwards a bare F10 to the renderer before the menu bar can take it", () => {
    const harness = fakeWindow();
    registerIpc({ window: harness.window });
    const call = vi.mocked(harness.window.webContents.on).mock.calls.find(
      ([name]) => name === "before-input-event",
    );
    const onBeforeInput = call?.[1] as (event: unknown, input: unknown) => void;
    const keyDown = { type: "keyDown", key: "F10", alt: false, control: false, shift: false, meta: false };

    const event = { preventDefault: vi.fn() };
    onBeforeInput(event, keyDown);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(harness.sent).toEqual([[IPC_CHANNELS.live.toggleRequested, undefined]]);

    const shifted = { preventDefault: vi.fn() };
    onBeforeInput(shifted, { ...keyDown, shift: true });
    onBeforeInput(shifted, { ...keyDown, key: "F9" });
    expect(shifted.preventDefault).not.toHaveBeenCalled();
    expect(harness.sent).toHaveLength(1);

    // F11 ends the brainstorm; a held key fires once.
    const end = { preventDefault: vi.fn() };
    onBeforeInput(end, { ...keyDown, key: "F11" });
    onBeforeInput(end, { ...keyDown, key: "F11", isAutoRepeat: true });
    expect(end.preventDefault).toHaveBeenCalledTimes(2);
    expect(harness.sent).toEqual([
      [IPC_CHANNELS.live.toggleRequested, undefined],
      [IPC_CHANNELS.live.endRequested, undefined],
    ]);
  });

  it("rejects requests from another WebContents or subframe", () => {
    const harness = fakeWindow();
    registerIpc({ window: harness.window });

    expect(() =>
      invoke(IPC_CHANNELS.app.getStartupContext, harness.foreignEvent),
    ).toThrow(/untrusted frame/);
    expect(() =>
      send(IPC_CHANNELS.app.respondToClose, harness.foreignEvent, true),
    ).not.toThrow();
    expect(harness.window.close).not.toHaveBeenCalled();
  });

  it("accepts only an explicit close approval", () => {
    const harness = fakeWindow();
    registerIpc({ window: harness.window });

    send(IPC_CHANNELS.app.respondToClose, harness.trustedEvent, false);
    expect(harness.window.close).not.toHaveBeenCalled();

    send(IPC_CHANNELS.app.respondToClose, harness.trustedEvent, true);
    expect(harness.window.close).toHaveBeenCalledOnce();
  });

  it("turns an empty clipboard into a no-op paste payload", async () => {
    electron.clipboard.readText.mockReturnValue("");
    const harness = fakeWindow();
    registerIpc({ window: harness.window });

    expect(
      await invoke(IPC_CHANNELS.clipboard.readForTerminal, harness.trustedEvent),
    ).toBeNull();
    expect(
      await invoke(IPC_CHANNELS.clipboard.importPaths, harness.trustedEvent, []),
    ).toBeNull();
  });

  it("kills owner PTYs on in-page reload and still cleans up on destroy", () => {
    const harness = fakeWindow();
    const cleanup = vi.fn();
    const services: IpcServices = {
      terminal: {
        spawn: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        cleanup,
      },
    };
    registerIpc({ window: harness.window, services });

    const listenerFor = (event: string) => {
      const call = vi.mocked(harness.window.webContents.on).mock.calls.find(
        ([name]) => name === event,
      );
      if (typeof call?.[1] !== "function") {
        throw new Error(`missing ${event} listener`);
      }
      return call[1] as () => void;
    };

    const onReload = listenerFor("did-start-loading");
    const onDestroyed = listenerFor("destroyed");
    const onGone = listenerFor("render-process-gone");

    onReload();
    expect(cleanup).toHaveBeenCalledWith(73);
    onReload();
    expect(cleanup).toHaveBeenCalledTimes(2);

    onDestroyed();
    expect(cleanup).toHaveBeenCalledTimes(3);
    onGone();
    expect(cleanup).toHaveBeenCalledTimes(3);
  });
});

describe("preload bridge", () => {
  async function loadApi(): Promise<HeadTerminalApi> {
    vi.resetModules();
    electron.ipcRenderer.reset();
    await import("../../electron/preload");
    return electron.exposed.headTerminal as HeadTerminalApi;
  }

  // e2e: an 11th pane tripped MaxListenersExceededWarning on terminal:data
  // and terminal:exit — every pane subscribing put its own listener on
  // ipcRenderer.
  it("keeps one IPC listener per channel however many panes subscribe", async () => {
    const api = await loadApi();
    const seen = Array.from({ length: 12 }, () => [] as string[]);
    const unsubscribe = seen.map((received, index) =>
      api.terminal.onData((event: PtyDataEvent) => {
        if (event.id === `pane-${index}`) received.push(String(event.data));
      }),
    );
    const exits = seen.map(() => api.terminal.onExit(() => undefined));

    expect(electron.ipcRenderer.listenerCount(IPC_CHANNELS.terminal.data)).toBe(1);
    expect(electron.ipcRenderer.listenerCount(IPC_CHANNELS.terminal.exit)).toBe(1);

    electron.ipcRenderer.emit(IPC_CHANNELS.terminal.data, { id: "pane-3", data: "oi" });
    expect(seen[3]).toEqual(["oi"]);
    expect(seen.filter((received) => received.length > 0)).toHaveLength(1);

    // Leaving twice is leaving once; the others keep receiving.
    unsubscribe[3]();
    unsubscribe[3]();
    electron.ipcRenderer.emit(IPC_CHANNELS.terminal.data, { id: "pane-3", data: "tchau" });
    electron.ipcRenderer.emit(IPC_CHANNELS.terminal.data, { id: "pane-4", data: "ainda" });
    expect(seen[3]).toEqual(["oi"]);
    expect(seen[4]).toEqual(["ainda"]);

    // The last one out takes the IPC listener along; the next one in is back.
    for (const leave of [...unsubscribe, ...exits]) leave();
    expect(electron.ipcRenderer.listenerCount(IPC_CHANNELS.terminal.data)).toBe(0);
    expect(electron.ipcRenderer.listenerCount(IPC_CHANNELS.terminal.exit)).toBe(0);
    const late: PtyDataEvent[] = [];
    api.terminal.onData((event) => late.push(event));
    electron.ipcRenderer.emit(IPC_CHANNELS.terminal.data, { id: "pane-9", data: "de volta" });
    expect(late).toEqual([{ id: "pane-9", data: "de volta" }]);
    expect(electron.ipcRenderer.listenerCount(IPC_CHANNELS.terminal.data)).toBe(1);
  });

  it("counts the same callback subscribed twice as two subscriptions", async () => {
    const api = await loadApi();
    const callback = vi.fn();
    const first = api.agentHooks.onEvent(callback);
    api.agentHooks.onEvent(callback);
    electron.ipcRenderer.emit(IPC_CHANNELS.agentHooks.event, { paneId: "p" });
    expect(callback).toHaveBeenCalledTimes(2);

    first();
    electron.ipcRenderer.emit(IPC_CHANNELS.agentHooks.event, { paneId: "p" });
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("delivers to every pane even when one of them throws, and still reports it", async () => {
    const api = await loadApi();
    const after = vi.fn();
    api.terminal.onExit(() => {
      throw new Error("pane quebrado");
    });
    api.terminal.onExit(after);

    expect(() =>
      electron.ipcRenderer.emit(IPC_CHANNELS.terminal.exit, { id: "p", exitCode: 0 }),
    ).toThrow("pane quebrado");
    expect(after).toHaveBeenCalledWith({ id: "p", exitCode: 0 });
  });

  it("does not hand the event being delivered to a pane that left or joined meanwhile", async () => {
    const api = await loadApi();
    const leaving = vi.fn();
    const joined = vi.fn();
    let leave: () => void = () => undefined;
    api.git.onChanged(() => {
      leave();
      api.git.onChanged(joined);
    });
    leave = api.git.onChanged(leaving);

    electron.ipcRenderer.emit(IPC_CHANNELS.git.changed, { watchId: "w" });
    expect(leaving).not.toHaveBeenCalled();
    expect(joined).not.toHaveBeenCalled();
  });
});
