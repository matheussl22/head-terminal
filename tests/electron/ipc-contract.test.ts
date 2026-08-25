import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const handles = new Map<string, (...args: unknown[]) => unknown>();
  const listeners = new Map<string, (...args: unknown[]) => unknown>();

  class Notification {
    static isSupported = vi.fn(() => true);
    on = vi.fn();
    show = vi.fn();
  }

  return {
    handles,
    listeners,
    app: {
      isPackaged: false,
      getVersion: vi.fn(() => "0.1.0-test"),
      getPath: vi.fn(() => "/tmp/head-terminal-test"),
    },
    clipboard: {
      readText: vi.fn(() => "clipboard value"),
      writeText: vi.fn(),
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
}));

import { IPC_CHANNELS } from "../../electron/ipc/channels";
import { registerIpc, type IpcServices } from "../../electron/ipc/register";

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
  vi.clearAllMocks();
});

describe("Electron IPC contract", () => {
  it("uses globally unique, capability-scoped channel names", () => {
    const channels = flattenChannels(IPC_CHANNELS);

    expect(new Set(channels).size).toBe(channels.length);
    expect(channels).toHaveLength(46);
    expect(channels.every((channel) => /^[a-z]+:[a-z][a-z-]*$/.test(channel))).toBe(true);
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
});
