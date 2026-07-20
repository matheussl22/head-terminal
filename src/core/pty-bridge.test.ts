import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../config/agents";
import {
  attachPtyDataListener,
  attachPtyExitListener,
  createPtyBridge,
} from "./pty-bridge";

type TerminalApi = Window["headTerminal"]["terminal"];
type DataCallback = Parameters<TerminalApi["onData"]>[0];
type ExitCallback = Parameters<TerminalApi["onExit"]>[0];

const profile: AgentProfile = {
  id: "shell",
  label: "Shell",
  command: "/bin/zsh",
  args: ["-l"],
};

interface TerminalMock {
  api: TerminalApi;
  spawn: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  unsubscribeData: ReturnType<typeof vi.fn>;
  unsubscribeExit: ReturnType<typeof vi.fn>;
  emitData(event: Parameters<DataCallback>[0]): void;
  emitExit(event: Parameters<ExitCallback>[0]): void;
}

function installTerminalMock(
  spawnImplementation?: TerminalApi["spawn"],
): TerminalMock {
  let dataCallback: DataCallback | undefined;
  let exitCallback: ExitCallback | undefined;
  const spawn = vi.fn(
    spawnImplementation ??
      (async (input) => ({ id: input.id, pid: 4242 })),
  );
  const write = vi.fn<TerminalApi["write"]>();
  const resize = vi.fn<TerminalApi["resize"]>();
  const kill = vi.fn<TerminalApi["kill"]>().mockResolvedValue(undefined);
  const unsubscribeData = vi.fn();
  const unsubscribeExit = vi.fn();
  const onData = vi.fn<TerminalApi["onData"]>((callback) => {
    dataCallback = callback;
    return unsubscribeData;
  });
  const onExit = vi.fn<TerminalApi["onExit"]>((callback) => {
    exitCallback = callback;
    return unsubscribeExit;
  });
  const api: TerminalApi = { spawn, write, resize, kill, onData, onExit };
  vi.stubGlobal("window", { headTerminal: { terminal: api } });

  return {
    api,
    spawn,
    write,
    resize,
    kill,
    unsubscribeData,
    unsubscribeExit,
    emitData: (event) => dataCallback?.(event),
    emitExit: (event) => exitCallback?.(event),
  };
}

describe("pty-bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("awaits a late spawn and can clean it up immediately afterwards", async () => {
    let resolveSpawn: ((value: { id: string; pid: number }) => void) | undefined;
    const terminal = installTerminalMock(
      vi.fn<TerminalApi["spawn"]>(
        () =>
          new Promise((resolve) => {
            resolveSpawn = resolve;
          }),
      ),
    );

    const pending = createPtyBridge({
      profile,
      cwd: "/repo",
      cols: 0,
      rows: -1,
    });
    expect(terminal.spawn).toHaveBeenCalledOnce();
    const input = terminal.spawn.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      command: "/bin/zsh",
      args: ["-l"],
      cwd: "/repo",
      cols: 80,
      rows: 24,
    });

    resolveSpawn?.({ id: input.id, pid: 99 });
    const bridge = await pending;
    expect(bridge.pty.pid).toBe(99);
    bridge.dispose();
    expect(terminal.kill).toHaveBeenCalledWith(input.id);
  });

  it("routes data and exit events only to their PTY id", async () => {
    const terminal = installTerminalMock();
    const bridge = await createPtyBridge({
      profile,
      cwd: "/repo",
      cols: 100,
      rows: 30,
    });
    const onData = vi.fn();
    const onExit = vi.fn();
    const dataSubscription = attachPtyDataListener(bridge.pty, onData);
    const exitSubscription = attachPtyExitListener(bridge.pty, onExit);

    terminal.emitData({ id: "some-other-pane", data: "ignored" });
    terminal.emitExit({ id: "some-other-pane", exitCode: 2 });
    terminal.emitData({ id: bridge.pty.id, data: "olá" });
    terminal.emitExit({ id: bridge.pty.id, exitCode: 7 });

    expect(new TextDecoder().decode(onData.mock.calls[0]?.[0])).toBe("olá");
    expect(onData).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledWith(7);
    dataSubscription.dispose();
    exitSubscription.dispose();
    expect(terminal.unsubscribeData).toHaveBeenCalledOnce();
    expect(terminal.unsubscribeExit).toHaveBeenCalledOnce();
  });

  it("batches writes and forwards resize and kill", async () => {
    const terminal = installTerminalMock();
    const bridge = await createPtyBridge({
      profile,
      cwd: "/repo",
      cols: 80,
      rows: 24,
      env: { CLAUDE_CONFIG_DIR: "/profile" },
    });

    bridge.write("a");
    bridge.write("b");
    expect(terminal.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4);
    expect(terminal.write).toHaveBeenCalledWith({
      id: bridge.pty.id,
      data: "ab",
    });

    bridge.pty.resize(132, 44);
    expect(terminal.resize).toHaveBeenCalledWith({
      id: bridge.pty.id,
      cols: 132,
      rows: 44,
    });
    bridge.pty.kill();
    expect(terminal.kill).toHaveBeenCalledWith(bridge.pty.id);
  });

  it("absorbs an asynchronous kill race during cleanup", async () => {
    const terminal = installTerminalMock();
    terminal.kill.mockRejectedValueOnce(new Error("already exited"));
    const bridge = await createPtyBridge({
      profile,
      cwd: "/repo",
      cols: 80,
      rows: 24,
    });
    bridge.dispose();
    bridge.dispose();
    await Promise.resolve();
    expect(terminal.kill).toHaveBeenCalledOnce();
  });

  it("cancels a buffered write when disposed before the flush", async () => {
    const terminal = installTerminalMock();
    const bridge = await createPtyBridge({
      profile,
      cwd: "/repo",
      cols: 80,
      rows: 24,
    });
    bridge.write("pending");
    bridge.dispose();
    await vi.advanceTimersByTimeAsync(10);
    expect(terminal.write).not.toHaveBeenCalled();
  });
});
