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
    // The POSIX spawn path, asserted regardless of the host running the suite.
    platform: "linux",
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

  it("logs the geometry that actually reaches node-pty on spawn and resize", () => {
    const logged: Array<[string, Record<string, unknown>]> = [];
    const service = new PtyService({
      env: {},
      platform: "linux",
      log: (event, meta) => logged.push([event, meta]),
      spawn: () => new FakePty(),
    });
    service.spawn(1, { id: "pane-1", command: "bash", cwd: "/tmp", cols: 132 });
    service.resize(1, "pane-1", 100, 30);

    expect(logged).toEqual([
      [
        "pty.spawned",
        expect.objectContaining({
          id: "pane-1",
          cols: 132,
          rows: 24,
          requestedCols: 132,
          requestedRows: undefined,
          cwd: "/tmp",
          requestedCwd: "/tmp",
          file: "bash",
        }),
      ],
      ["pty.resized", { id: "pane-1", cols: 100, rows: 30 }],
    ]);
  });

  it("forwards terminal output unchanged, including OSC and escape sequences", () => {
    vi.useFakeTimers();
    try {
      const { service, processes, events } = harness();
      service.spawn(4, { id: "pane-osc", command: "bash", cwd: "/tmp" });
      const raw = "\u001b]7;file://host/worktree\u0007\u001b[31mred\u001b[0m";

      processes[0]?.data(raw);
      expect(events).toEqual([]);
      vi.advanceTimersByTime(16);
      expect(events).toEqual([
        {
          channel: "pty:data",
          ownerId: 4,
          payload: { id: "pane-osc", data: raw },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces successive onData bursts into one IPC message", () => {
    vi.useFakeTimers();
    try {
      const { service, processes, events } = harness();
      service.spawn(4, { id: "pane-batch", command: "bash", cwd: "/tmp" });

      processes[0]?.data("hel");
      processes[0]?.data("lo");
      expect(events).toEqual([]);
      vi.advanceTimersByTime(16);

      expect(events).toEqual([
        {
          channel: "pty:data",
          ownerId: 4,
          payload: { id: "pane-batch", data: "hello" },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes coalesced output immediately on process exit", () => {
    const { service, processes, events } = harness();
    service.spawn(2, { id: "pane-a", command: "bash", cwd: "/tmp" });

    processes[0]?.data("bye");
    processes[0]?.exit(17, 9);

    expect(service.has(2, "pane-a")).toBe(false);
    expect(events).toEqual([
      {
        channel: "pty:data",
        ownerId: 2,
        payload: { id: "pane-a", data: "bye" },
      },
      {
        channel: "pty:exit",
        ownerId: 2,
        payload: { id: "pane-a", exitCode: 17, signal: 9 },
      },
    ]);
  });

  it("flushes immediately once pending output hits the size cap", () => {
    const { service, processes, events } = harness();
    service.spawn(1, { id: "pane-cap", command: "bash", cwd: "/tmp" });
    const chunk = "x".repeat(128 * 1024);

    processes[0]?.data(chunk);

    expect(events).toEqual([
      {
        channel: "pty:data",
        ownerId: 1,
        payload: { id: "pane-cap", data: chunk },
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

  it("cleans one owner idempotently without affecting other owners", async () => {
    const { service, processes, events } = harness();
    service.spawn(1, { id: "pane-a", command: "bash", cwd: "/tmp" });
    service.spawn(1, { id: "pane-b", command: "bash", cwd: "/tmp" });
    service.spawn(2, { id: "pane-a", command: "bash", cwd: "/tmp" });

    await expect(service.cleanup(1)).resolves.toBe(2);
    await expect(service.cleanup(1)).resolves.toBe(0);
    expect(service.size).toBe(1);
    expect(processes.map((pty) => pty.killed)).toEqual([1, 1, 0]);
    expect(events).toEqual([]);
  });

  it("kills and disposes idempotently even when process.kill throws", async () => {
    const { service, processes } = harness();
    service.spawn(1, { id: "pane-a", command: "bash", cwd: "/tmp" });
    service.spawn(1, { id: "pane-b", command: "bash", cwd: "/tmp" });
    vi.spyOn(processes[0]!, "kill").mockImplementation(() => {
      throw new Error("already gone");
    });

    await expect(service.kill(1, "pane-a")).resolves.toBe(true);
    await expect(service.kill(1, "pane-a")).resolves.toBe(false);
    await expect(service.dispose()).resolves.toBe(1);
    await expect(service.dispose()).resolves.toBe(0);
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

describe("PtyService on Windows", () => {
  const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const SHELL_ARGS = ["-NoLogo", "-NoExit", "-EncodedCommand", "AAA="];

  function windowsHarness(options?: { existing?: string[]; hangKill?: boolean }) {
    const killed: number[] = [];
    const processes: FakePty[] = [];
    const calls: Array<{
      file: string;
      args: string[];
      options: NodePtySpawnOptions;
    }> = [];
    const existing = new Set(options?.existing ?? ["C:\\Users\\m\\repo", "C:\\Users\\m"]);
    const service = new PtyService({
      platform: "win32",
      env: { PATH: "C:\\Windows" },
      windowsHome: "C:\\Users\\m",
      windowsShell: PWSH,
      pathExists: (path) => existing.has(path),
      killWindowsTree: async (pid) => {
        killed.push(pid);
        if (options?.hangKill) {
          await new Promise(() => {
            // Never settles: kill/dispose must time out instead of hanging.
          });
        }
      },
      spawn: (file, args, spawnOptions) => {
        calls.push({ file, args, options: spawnOptions });
        const processPty = new FakePty();
        processes.push(processPty);
        return processPty;
      },
    });
    return { service, calls, processes, killed };
  }

  it("resolves the abstract powershell command to the installed executable", () => {
    const { service, calls } = windowsHarness();

    service.spawn(7, {
      id: "pane-1",
      command: "powershell",
      args: SHELL_ARGS,
      cwd: "C:\\Users\\m\\repo",
    });

    expect(calls[0].file).toBe(PWSH);
    expect(calls[0].args).toEqual(SHELL_ARGS);
    expect(calls[0].options.cwd).toBe("C:\\Users\\m\\repo");
  });

  it("leaves an explicit executable alone", () => {
    const { service, calls } = windowsHarness();

    service.spawn(7, {
      id: "pane-1",
      command: "C:\\Tools\\nu.exe",
      cwd: "C:\\Users\\m\\repo",
    });

    expect(calls[0].file).toBe("C:\\Tools\\nu.exe");
  });

  it("translates a cwd persisted by the WSL-era app", () => {
    const { service, calls } = windowsHarness();

    service.spawn(7, {
      id: "pane-1",
      command: "powershell",
      cwd: "/mnt/c/Users/m/repo",
    });

    expect(calls[0].options.cwd).toBe("C:\\Users\\m\\repo");
  });

  it("opens in the home when the cwd is gone or has no Windows equivalent", () => {
    const { service, calls } = windowsHarness();

    service.spawn(7, { id: "pane-1", command: "powershell", cwd: "/home/m/repo" });
    service.spawn(7, { id: "pane-2", command: "powershell", cwd: "C:\\Users\\m\\gone" });

    expect(calls.map((call) => call.options.cwd)).toEqual([
      "C:\\Users\\m",
      "C:\\Users\\m",
    ]);
  });

  it("kills the whole process tree on close, not just the shell", async () => {
    const { service, processes, killed } = windowsHarness();

    service.spawn(7, { id: "pane-1", command: "powershell", cwd: "C:\\Users\\m" });
    await expect(service.kill(7, "pane-1")).resolves.toBe(true);

    expect(killed).toEqual([processes[0]!.pid]);
    expect(processes[0]?.killed).toBe(1);
  });

  it("does not taskkill a tree that already exited on its own", () => {
    const { service, processes, killed } = windowsHarness();

    service.spawn(7, { id: "pane-1", command: "powershell", cwd: "C:\\Users\\m" });
    processes[0]?.exit(0);

    expect(service.has(7, "pane-1")).toBe(false);
    expect(killed).toEqual([]);
  });

  it("gives up on a hung tree kill so dispose cannot block forever", async () => {
    vi.useFakeTimers();
    try {
      const { service } = windowsHarness({ hangKill: true });
      service.spawn(7, { id: "pane-1", command: "powershell", cwd: "C:\\Users\\m" });
      const disposed = service.dispose();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(disposed).resolves.toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
