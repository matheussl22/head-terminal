import { describe, expect, it, vi } from "vitest";

import {
  PtyService,
  type Disposable,
  type NodePtySpawnOptions,
  type PtyProcess,
  type PtyServiceEvent,
} from "../../electron/services/pty-service";

class FakePty implements PtyProcess {
  readonly pid = 4321;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = 0;
  private dataListener?: (data: string) => void;
  private exitListener?: (event: { exitCode: number; signal?: number }) => void;

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  kill(): void {
    this.killed += 1;
    this.exitListener?.({ exitCode: 0, signal: 15 });
  }

  onData(listener: (data: string) => void): Disposable {
    this.dataListener = listener;
    return { dispose: () => (this.dataListener = undefined) };
  }

  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): Disposable {
    this.exitListener = listener;
    return { dispose: () => (this.exitListener = undefined) };
  }

  data(data: string): void {
    this.dataListener?.(data);
  }

  exit(exitCode: number, signal?: number): void {
    this.exitListener?.({ exitCode, signal });
  }
}

function harness(baseEnv: NodeJS.ProcessEnv = {}) {
  const processes: FakePty[] = [];
  const calls: Array<{
    file: string;
    args: string[];
    options: NodePtySpawnOptions;
  }> = [];
  const events: PtyServiceEvent[] = [];
  const service = new PtyService({
    env: baseEnv,
    emit: (event) => events.push(event),
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      const processPty = new FakePty();
      processes.push(processPty);
      return processPty;
    },
  });
  return { service, processes, calls, events };
}

describe("PtyService", () => {
  it("spawns with pane dimensions, cwd, args and a color-capable env", () => {
    const { service, calls } = harness({
      PATH: "/bin",
      NO_COLOR: "1",
      NODE_DISABLE_COLORS: "1",
    });

    expect(
      service.spawn(7, {
        id: "32cc35ed-e92e-4f65-b46f-c648d988ab3a",
        command: "claude",
        args: ["--resume", "abc"],
        cwd: "/workspace",
        cols: 132,
        rows: 41,
        env: { LANG: "pt_BR.utf8", CUSTOM: "yes" },
      }),
    ).toEqual({ id: "32cc35ed-e92e-4f65-b46f-c648d988ab3a", pid: 4321 });

    expect(calls[0]).toEqual({
      file: "claude",
      args: ["--resume", "abc"],
      options: {
        name: "xterm-256color",
        cols: 132,
        rows: 41,
        cwd: "/workspace",
        env: {
          PATH: "/bin",
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          LANG: "pt_BR.utf8",
          CUSTOM: "yes",
        },
      },
    });
  });

  it("drops the parent agent session markers so a pane is never a nested session", () => {
    const { service, calls } = harness({
      PATH: "/bin",
      HOME: "/home/dev",
      // Head Terminal launched from inside a Claude Code session.
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ID: "b7cefdfb-5519-46d1-a737-7525d3da4089",
      CLAUDE_PID: "45931",
      AI_AGENT: "claude-code_2-1-226_agent",
      CLAUDE_CONFIG_DIR: "/home/dev/.parent-profile",
    });

    service.spawn(1, {
      id: "pane-1",
      command: "claude",
      cwd: "/workspace",
      env: { CLAUDE_CONFIG_DIR: "/home/dev/.pane-account" },
    });

    const env = calls[0]?.options.env ?? {};
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/home/dev" });
    expect(Object.keys(env).filter((key) => key.startsWith("CLAUDE_CODE_"))).toEqual([]);
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_PID).toBeUndefined();
    expect(env.AI_AGENT).toBeUndefined();
    // The pane's own account still decides where Claude reads and writes.
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/dev/.pane-account");
  });

  it("leaves a pane without its own account on the default Claude config", () => {
    const { service, calls } = harness({
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: "/home/dev/.parent-profile",
    });

    service.spawn(1, { id: "pane-1", command: "claude", cwd: "/workspace" });

    expect(calls[0]?.options.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("uses 80x24 defaults and forwards writes and resizes", () => {
    const { service, processes, calls } = harness();
    service.spawn(1, { id: "pane-1", command: "bash", cwd: "/tmp" });

    expect(calls[0]?.options).toMatchObject({ cols: 80, rows: 24 });
    service.write(1, "pane-1", "echo ok\r\0");
    service.resize(1, "pane-1", 100, 30);

    expect(processes[0]?.writes).toEqual(["echo ok\r\0"]);
    expect(processes[0]?.resizes).toEqual([[100, 30]]);
  });

  it("forwards terminal output unchanged, including OSC and escape sequences", () => {
    const { service, processes, events } = harness();
    service.spawn(4, { id: "pane-osc", command: "bash", cwd: "/tmp" });
    const raw = "\u001b]7;file://host/worktree\u0007\u001b[31mred\u001b[0m";

    processes[0]?.data(raw);

    expect(events).toEqual([
      {
        channel: "pty:data",
        ownerId: 4,
        payload: { id: "pane-osc", data: raw },
      },
    ]);
  });

  it("removes a naturally exited PTY before publishing its exit event", () => {
    const { service, processes, events } = harness();
    service.spawn(2, { id: "pane-a", command: "bash", cwd: "/tmp" });

    processes[0]?.exit(17, 9);

    expect(service.has(2, "pane-a")).toBe(false);
    expect(events).toEqual([
      {
        channel: "pty:exit",
        ownerId: 2,
        payload: { id: "pane-a", exitCode: 17, signal: 9 },
      },
    ]);
  });

  it("isolates identical pane ids by WebContents owner", () => {
    const { service, processes } = harness();
    service.spawn(10, { id: "shared-pane", command: "bash", cwd: "/tmp" });
    service.spawn(11, { id: "shared-pane", command: "zsh", cwd: "/tmp" });

    service.write(10, "shared-pane", "owner ten");
    expect(processes[0]?.writes).toEqual(["owner ten"]);
    expect(processes[1]?.writes).toEqual([]);
    expect(() => service.write(12, "shared-pane", "intrusion")).toThrow(
      "PTY not found",
    );
  });

  it("rejects duplicate panes without replacing or leaking the original", () => {
    const { service, processes } = harness();
    const request = { id: "pane-a", command: "bash", cwd: "/tmp" };
    service.spawn(1, request);

    expect(() => service.spawn(1, request)).toThrow("PTY already exists");
    expect(service.size).toBe(1);
    expect(processes).toHaveLength(1);
    expect(processes[0]?.killed).toBe(0);
  });

  it("cleans one owner idempotently without affecting other owners", () => {
    const { service, processes, events } = harness();
    service.spawn(1, { id: "pane-a", command: "bash", cwd: "/tmp" });
    service.spawn(1, { id: "pane-b", command: "bash", cwd: "/tmp" });
    service.spawn(2, { id: "pane-a", command: "bash", cwd: "/tmp" });

    expect(service.cleanup(1)).toBe(2);
    expect(service.cleanup(1)).toBe(0);
    expect(service.size).toBe(1);
    expect(processes.map((pty) => pty.killed)).toEqual([1, 1, 0]);
    expect(events).toEqual([]);
  });

  it("kills and disposes idempotently even when process.kill throws", () => {
    const { service, processes } = harness();
    service.spawn(1, { id: "pane-a", command: "bash", cwd: "/tmp" });
    service.spawn(1, { id: "pane-b", command: "bash", cwd: "/tmp" });
    vi.spyOn(processes[0]!, "kill").mockImplementation(() => {
      throw new Error("already gone");
    });

    expect(service.kill(1, "pane-a")).toBe(true);
    expect(service.kill(1, "pane-a")).toBe(false);
    expect(service.dispose()).toBe(1);
    expect(service.dispose()).toBe(0);
    expect(service.size).toBe(0);
  });

  it.each([
    ["invalid owner", () => harness().service.spawn(0, { id: "pane", command: "bash", cwd: "/tmp" })],
    ["invalid id", () => harness().service.spawn(1, { id: "../pane", command: "bash", cwd: "/tmp" })],
    ["invalid cols", () => harness().service.spawn(1, { id: "pane", command: "bash", cwd: "/tmp", cols: 0 })],
    ["invalid rows", () => harness().service.spawn(1, { id: "pane", command: "bash", cwd: "/tmp", rows: 1.5 })],
    ["NUL command", () => harness().service.spawn(1, { id: "pane", command: "ba\0sh", cwd: "/tmp" })],
    ["NUL env", () => harness().service.spawn(1, { id: "pane", command: "bash", cwd: "/tmp", env: { BAD: "x\0y" } })],
  ])("validates %s", (_label, action) => {
    expect(action).toThrow();
  });
});
