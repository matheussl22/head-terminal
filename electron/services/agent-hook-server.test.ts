import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentHookEventPayload } from "../types/api";
import {
  AgentHookServer,
  CLAUDE_STATUS_HOOK_EVENTS,
  MAX_HOOK_BODY_BYTES,
  MIN_CLAUDE_HOOKS_VERSION,
  PANE_FILE_MAX_AGE_MS,
  buildClaudeHookSettings,
  compareVersions,
  extractHookFields,
  parseClaudeVersion,
  probeInstalledClaudeVersion,
  toHookPayload,
} from "./agent-hook-server";
import { resetCommandRunner, setCommandRunner } from "./command-runner";

const PANE = "0d4c9a51-7f39-4a8e-9b0e-2d6f1c3e5a77";
const PANE_B = "5b7e0f2c-1d3a-4c8b-9e6f-7a2d4b1c0e99";
const DAY_MS = 24 * 60 * 60_000;
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  resetCommandRunner();
  // Servers before their directories.
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function makeUserData(): Promise<string> {
  const userDataPath = await mkdtemp(join(tmpdir(), "ht-agent-hooks-"));
  cleanup.push(() => rm(userDataPath, { recursive: true, force: true }));
  return userDataPath;
}

async function startServer(
  options: {
    version?: string | null;
    probe?: () => Promise<string | null>;
    now?: () => number;
    userDataPath?: string;
  } = {},
) {
  const userDataPath = options.userDataPath ?? (await makeUserData());
  const version = "version" in options ? (options.version ?? null) : "2.1.283";
  const probe = options.probe ?? vi.fn(async () => version);
  const logs: Array<{ event: string; meta?: Record<string, unknown> }> = [];
  const server = new AgentHookServer({
    userDataPath,
    probeClaudeVersion: probe,
    now: options.now,
    log: (event, meta) => logs.push({ event, meta }),
  });
  cleanup.push(() => server.close());
  const events: AgentHookEventPayload[] = [];
  server.onEvent((payload) => events.push(payload));
  await server.start();
  return { server, events, logs, userDataPath, probe, url: new URL(server.hookUrl) };
}

const paneFile = (userDataPath: string, paneId: string) =>
  join(userDataPath, "agent-hooks", "panes", `${paneId}.json`);

interface PostOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

function post(url: URL, options: PostOptions = {}): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: url.port,
        method: options.method ?? "POST",
        path: options.path ?? url.pathname,
        headers: {
          "content-type": "application/json",
          "x-ht-pane": PANE,
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            type: res.headers["content-type"],
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body ?? "");
  });
}

/** What Claude does with a pane file: POST to its URL with its headers. */
async function postAsClaude(settingsPath: string, body: object) {
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  const handler = settings.hooks.Stop[0].hooks[0];
  return post(new URL(handler.url), { headers: handler.headers, body: JSON.stringify(body) });
}

/** The listener runs right after the response is written. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function occupy(port: number): Promise<NetServer> {
  return new Promise((resolve, reject) => {
    const blocker = createNetServer();
    blocker.once("error", reject);
    blocker.listen(port, "127.0.0.1", () => resolve(blocker));
  });
}

describe("buildClaudeHookSettings", () => {
  it("posts every status event to the URL with the pane id written literally", () => {
    const settings = buildClaudeHookSettings("http://127.0.0.1:4321/claude-hook/abc", PANE);
    expect(Object.keys(settings.hooks)).toEqual([
      "UserPromptSubmit",
      "PermissionRequest",
      "Notification",
      "Elicitation",
      "ElicitationResult",
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
      "StopFailure",
    ]);
    // SessionStart only runs command/mcp_tool hooks.
    expect(settings.hooks.SessionStart).toBeUndefined();
    for (const [event, groups] of Object.entries(settings.hooks)) {
      expect(groups).toHaveLength(1);
      // No `$HT_PANE_ID` and no allowedEnvVars: a background session takes
      // its env from Claude's supervisor, i.e. from whichever pane started
      // it first, while this file travels with the session.
      expect(groups[0].hooks).toEqual([
        {
          type: "http",
          url: "http://127.0.0.1:4321/claude-hook/abc",
          timeout: 3,
          headers: { "x-ht-pane": PANE },
        },
      ]);
      const takesMatcher = CLAUDE_STATUS_HOOK_EVENTS.find((entry) => entry.event === event)?.matcher;
      expect("matcher" in groups[0]).toBe(Boolean(takesMatcher));
    }
    expect(settings.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(settings.hooks.Stop[0].matcher).toBeUndefined();
    expect(settings.hooks.PermissionRequest[0].matcher).toBe("*");
    expect(JSON.stringify(settings)).not.toContain("$");
  });

  it("refuses a pane id Claude could read as an env var or a path", () => {
    for (const bad of ["$HT_PANE_ID", "../x", "a b", "", "x".repeat(65)]) {
      expect(() => buildClaudeHookSettings("http://127.0.0.1:1/claude-hook/a", bad)).toThrow(TypeError);
    }
  });
});

describe("Claude version gate", () => {
  it("reads the version out of `claude --version`, shell noise included", () => {
    expect(parseClaudeVersion("2.1.283 (Claude Code)\n")).toBe("2.1.283");
    expect(parseClaudeVersion("Welcome back!\n1.9.0\n2.1.122 (Claude Code)\n")).toBe("2.1.122");
    expect(parseClaudeVersion("v2.0.45\n")).toBe("2.0.45");
    expect(parseClaudeVersion("command not found: claude")).toBeNull();
  });

  it("compares versions numerically, not as text", () => {
    expect(compareVersions("2.1.283", MIN_CLAUDE_HOOKS_VERSION)).toBe(1);
    expect(compareVersions("2.1.122", "2.1.122")).toBe(0);
    expect(compareVersions("2.1.99", "2.1.122")).toBe(-1);
    expect(compareVersions("2.10.0", "2.9.9")).toBe(1);
    expect(compareVersions("3", "2.1.122")).toBe(1);
  });

  it("asks the pane's PowerShell on Windows, never where.exe or cmd.exe", async () => {
    const calls: Array<[string, readonly string[]]> = [];
    setCommandRunner(async (command, args) => {
      calls.push([command, args]);
      return { stdout: "2.1.200 (Claude Code)\r\n", stderr: "" };
    });
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    await expect(probeInstalledClaudeVersion("win32", () => pwsh)).resolves.toBe("2.1.200");
    expect(calls).toEqual([
      [
        pwsh,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "claude --version"],
      ],
    ]);
  });

  it("gives up quietly when PowerShell finds no claude", async () => {
    setCommandRunner(async () => {
      throw Object.assign(new Error("The term 'claude' is not recognized"), { code: 1 });
    });
    await expect(probeInstalledClaudeVersion("win32", () => "powershell.exe")).resolves.toBeNull();
  });

  // The real thing: a claude.cmd shim in a profile folder with an accented
  // name and cmd.exe metacharacters. `where.exe` printed `João` in the OEM
  // code page (read back as `Jo�o`), and `cmd.exe /d /c <path>` split the
  // path at `&` — both left the hooks off for the whole run.
  it.runIf(process.platform === "win32")(
    "finds claude on a PATH with a non-ASCII name and a '&' (C:\\Users\\João & Cia)",
    async () => {
      const root = await makeUserData();
      const bin = join(root, "João & A&B (x86)", "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "claude.cmd"), "@echo 7.7.777 (Claude Code)\r\n");
      const originalPath = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
      try {
        // A version no real install has: proof the fake, not the real claude, answered.
        await expect(probeInstalledClaudeVersion("win32")).resolves.toBe("7.7.777");
      } finally {
        process.env.PATH = originalPath;
      }
    },
    15_000,
  );

  it("probes through a login zsh elsewhere and gives up quietly", async () => {
    const calls: Array<[string, readonly string[]]> = [];
    setCommandRunner(async (command, args) => {
      calls.push([command, args]);
      throw Object.assign(new Error("spawn zsh ENOENT"), { code: "ENOENT" });
    });
    await expect(probeInstalledClaudeVersion("darwin")).resolves.toBeNull();
    expect(calls[0][0]).toBe("zsh");
    expect(calls[0][1][1]).toContain("claude --version");
    expect(calls[0][1][1]).toContain("$HOME/.local/bin");
  });
});

describe("hook body parsing", () => {
  it("keeps only the status fields of a full body, the session id included", () => {
    const body = Buffer.from(JSON.stringify({
      session_id: "3f2c1a9e-7b4d-4e21-9c55-0a1b2c3d4e5f",
      transcript_path: "/t.jsonl",
      cwd: "/repo",
      hook_event_name: "PermissionRequest",
      tool_name: "Write",
      tool_input: { file_path: "/repo/a.txt", content: "x".repeat(1_000) },
      permission_suggestions: [],
    }));
    const fields = extractHookFields(body, true);
    expect(toHookPayload(PANE, fields!, 42)).toEqual({
      paneId: PANE,
      source: "claude",
      event: "PermissionRequest",
      toolName: "Write",
      sessionId: "3f2c1a9e-7b4d-4e21-9c55-0a1b2c3d4e5f",
      receivedAt: 42,
    });
  });

  it("trims the session id and drops one that is not id-shaped", () => {
    const payload = (session_id: unknown) =>
      toHookPayload(PANE, { hook_event_name: "Stop", session_id }, 1);
    expect(payload("  abc-123_DEF \n")?.sessionId).toBe("abc-123_DEF");
    for (const bad of ["", "a b", "../x", "x".repeat(129), 42, null]) {
      expect(payload(bad)).not.toHaveProperty("sessionId");
    }
  });

  it("finds the fields in the head of a body that went past the cap", () => {
    const text = JSON.stringify({
      session_id: "s",
      hook_event_name: "PermissionRequest",
      tool_name: "Write",
      tool_input: { content: "y".repeat(3 * MAX_HOOK_BODY_BYTES) },
    });
    const truncated = Buffer.from(text).subarray(0, MAX_HOOK_BODY_BYTES);
    const fields = extractHookFields(truncated, false);
    expect(fields).toMatchObject({
      session_id: "s",
      hook_event_name: "PermissionRequest",
      tool_name: "Write",
    });
  });

  it("does not take a field name quoted inside another string", () => {
    const text = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_input: { content: "{\"hook_event_name\":\"Stop\",\"tool_name\":\"Evil\"}" },
    });
    const fields = extractHookFields(Buffer.from(text.slice(0, -5)), true);
    expect(fields).toMatchObject({ hook_event_name: "PostToolUse" });
    expect(fields?.tool_name).toBeUndefined();
  });

  it("drops a body that names no event, or names it oddly", () => {
    expect(extractHookFields(Buffer.from("not json"), true)).toBeNull();
    expect(extractHookFields(Buffer.from("[1,2]"), true)).toBeNull();
    expect(toHookPayload(PANE, { hook_event_name: "Stop; rm -rf /" }, 1)).toBeNull();
    expect(toHookPayload(PANE, { hook_event_name: 7 }, 1)).toBeNull();
  });

  it("keeps an empty agent_type, trims long strings and control characters", () => {
    const payload = toHookPayload(
      PANE,
      {
        hook_event_name: "StopFailure",
        agent_type: "",
        error: `rate_limit\n${"z".repeat(1_000)}`,
        notification_type: 12,
      },
      5,
    );
    expect(payload?.agentType).toBe("");
    expect(payload?.error?.startsWith("rate_limit z")).toBe(true);
    expect(payload?.error).toHaveLength(256);
    expect(payload).not.toHaveProperty("notificationType");
  });
});

describe("AgentHookServer", () => {
  it("writes one settings file per pane and hands out that pane's own", async () => {
    const { server, userDataPath, url } = await startServer();
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toMatch(/^\/claude-hook\/[0-9a-f]{64}$/u);

    expect(await server.getClaudeSettings(PANE)).toEqual({ settingsPath: paneFile(userDataPath, PANE) });
    expect(await server.getClaudeSettings(PANE_B)).toEqual({ settingsPath: paneFile(userDataPath, PANE_B) });
    expect(JSON.parse(await readFile(paneFile(userDataPath, PANE), "utf8")))
      .toEqual(buildClaudeHookSettings(server.hookUrl, PANE));
    expect(JSON.parse(await readFile(paneFile(userDataPath, PANE_B), "utf8")))
      .toEqual(buildClaudeHookSettings(server.hookUrl, PANE_B));
  });

  // Review hooks-security#0: pane A's Claude starts the background
  // supervisor, so every background worker inherits HT_PANE_ID=A; a session
  // sent to the background from pane B still carries B's `--settings`.
  it("routes by the pane file a session was started with, whatever env it inherited", async () => {
    const { server, events } = await startServer();
    const settingsA = (await server.getClaudeSettings(PANE))!.settingsPath;
    const settingsB = (await server.getClaudeSettings(PANE_B))!.settingsPath;

    await postAsClaude(settingsB, { hook_event_name: "UserPromptSubmit", session_id: "sess-b" });
    await postAsClaude(settingsA, { hook_event_name: "Stop", session_id: "sess-a" });
    await settle();
    expect(events.map((event) => [event.paneId, event.event, event.sessionId])).toEqual([
      [PANE_B, "UserPromptSubmit", "sess-b"],
      [PANE, "Stop", "sess-a"],
    ]);
  });

  it("hands out nothing for a malformed pane id and writes no file for it", async () => {
    const { server, userDataPath } = await startServer();
    for (const bad of ["", "../../evil", "a b", "$HT_PANE_ID", "x".repeat(65)]) {
      expect(await server.getClaudeSettings(bad)).toBeNull();
    }
    await expect(stat(join(userDataPath, "agent-hooks", "panes"))).rejects.toThrow();
  });

  // Review hooks-security#4: Claude exits with "Settings file not found" on
  // a missing --settings file, so the path is only handed out once the file
  // is back.
  it("rewrites a pane file deleted under the app before handing its path out again", async () => {
    const { server, userDataPath } = await startServer();
    const { settingsPath } = (await server.getClaudeSettings(PANE))!;
    await rm(join(userDataPath, "agent-hooks"), { recursive: true, force: true });

    expect(await server.getClaudeSettings(PANE)).toEqual({ settingsPath });
    expect(JSON.parse(await readFile(settingsPath, "utf8")))
      .toEqual(buildClaudeHookSettings(server.hookUrl, PANE));
  });

  it("hands out nothing when the pane file cannot be written", async () => {
    const { server, userDataPath, logs } = await startServer();
    await mkdir(join(userDataPath, "agent-hooks"), { recursive: true });
    // A plain file where the folder should be: every write under it fails.
    await writeFile(join(userDataPath, "agent-hooks", "panes"), "not a folder");

    expect(await server.getClaudeSettings(PANE)).toBeNull();
    expect(logs.map((entry) => entry.event)).toContain("agent-hooks.settings_write_failed");
  });

  it("touches an up-to-date pane file on each spawn instead of rewriting it", async () => {
    const { server, userDataPath } = await startServer();
    const { settingsPath } = (await server.getClaudeSettings(PANE))!;
    const old = new Date(Date.now() - 10 * DAY_MS);
    await utimes(settingsPath, old, old);

    await server.getClaudeSettings(PANE);
    expect((await stat(paneFile(userDataPath, PANE))).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });

  // Review hooks-security#1: a background worker that outlived the app keeps
  // posting to the URL it was started with.
  it("comes back on the same port and token after a restart, leaving the pane files alone", async () => {
    const userDataPath = await makeUserData();
    const first = await startServer({ userDataPath });
    const { settingsPath } = (await first.server.getClaudeSettings(PANE))!;
    const written = await readFile(settingsPath, "utf8");
    const old = new Date(Date.now() - 3 * DAY_MS);
    await utimes(settingsPath, old, old);
    await first.server.close();

    const second = await startServer({ userDataPath });
    expect(second.server.hookUrl).toBe(first.server.hookUrl);
    expect(await readFile(settingsPath, "utf8")).toBe(written);
    expect(Math.abs((await stat(settingsPath)).mtimeMs - old.getTime())).toBeLessThan(2_000);

    // The worker started by the first run reaches the second one.
    expect((await postAsClaude(settingsPath, { hook_event_name: "Stop" })).status).toBe(200);
    await settle();
    expect(second.events).toEqual([expect.objectContaining({ paneId: PANE, event: "Stop" })]);
    const state = JSON.parse(await readFile(join(userDataPath, "agent-hooks", "state.json"), "utf8"));
    expect(state).toEqual({ port: Number(first.url.port), token: first.url.pathname.split("/").pop() });
  });

  it("moves to a new port and token when the saved port is taken, and repoints every pane file", async () => {
    const userDataPath = await makeUserData();
    const first = await startServer({ userDataPath });
    const { settingsPath } = (await first.server.getClaudeSettings(PANE))!;
    const old = new Date(Date.now() - 3 * DAY_MS);
    await utimes(settingsPath, old, old);
    await first.server.close();
    const blocker = await occupy(Number(first.url.port));
    cleanup.push(() => new Promise((resolve) => blocker.close(resolve)));

    const second = await startServer({ userDataPath });
    expect(second.url.port).not.toBe(first.url.port);
    expect(second.url.pathname).not.toBe(first.url.pathname);
    expect(second.logs.map((entry) => entry.event)).toContain("agent-hooks.saved_port_unavailable");
    // Surviving workers re-read the file when they respawn: it must name the
    // live server, and still count as untouched since its last spawn.
    expect(JSON.parse(await readFile(settingsPath, "utf8")))
      .toEqual(buildClaudeHookSettings(second.server.hookUrl, PANE));
    expect(Math.abs((await stat(settingsPath)).mtimeMs - old.getTime())).toBeLessThan(2_000);
    const state = JSON.parse(await readFile(join(userDataPath, "agent-hooks", "state.json"), "utf8"));
    expect(state).toEqual({ port: Number(second.url.port), token: second.url.pathname.split("/").pop() });
  });

  it("starts fresh on a damaged state file", async () => {
    const userDataPath = await makeUserData();
    await mkdir(join(userDataPath, "agent-hooks"), { recursive: true });
    await writeFile(join(userDataPath, "agent-hooks", "state.json"), "{\"port\":\"80\",\"token\":\"x\"}");
    const { server, url } = await startServer({ userDataPath });
    expect(url.pathname).toMatch(/^\/claude-hook\/[0-9a-f]{64}$/u);
    const state = JSON.parse(await readFile(join(userDataPath, "agent-hooks", "state.json"), "utf8"));
    expect(state).toEqual({ port: Number(url.port), token: url.pathname.split("/").pop() });
    expect(server.hookUrl).toContain(state.token);
  });

  it.skipIf(process.platform === "win32")("keeps the state file owner-only", async () => {
    const { userDataPath } = await startServer();
    const mode = (await stat(join(userDataPath, "agent-hooks", "state.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("prunes, at startup, only the pane files no spawn asked for in 30 days", async () => {
    const userDataPath = await makeUserData();
    const panes = join(userDataPath, "agent-hooks", "panes");
    await mkdir(panes, { recursive: true });
    const stale = new Date(Date.now() - PANE_FILE_MAX_AGE_MS - DAY_MS);
    const recent = new Date(Date.now() - PANE_FILE_MAX_AGE_MS + DAY_MS);
    const files = {
      stale: join(panes, `${PANE}.json`),
      recent: join(panes, `${PANE_B}.json`),
      leftover: join(panes, `${PANE}.json.123.abcd.tmp`),
      stranger: join(panes, "notes.txt"),
    };
    for (const file of Object.values(files)) await writeFile(file, "{}");
    await utimes(files.stale, stale, stale);
    await utimes(files.leftover, stale, stale);
    await utimes(files.stranger, stale, stale);
    await utimes(files.recent, recent, recent);

    const { server } = await startServer({ userDataPath });
    await expect(stat(files.stale)).rejects.toThrow();
    await expect(stat(files.leftover)).rejects.toThrow();
    expect(await readFile(files.stranger, "utf8")).toBe("{}");
    // Kept, and pointed at this run's server.
    expect(JSON.parse(await readFile(files.recent, "utf8")))
      .toEqual(buildClaudeHookSettings(server.hookUrl, PANE_B));
  });

  it("answers a hook with an empty decision and routes the event to its pane", async () => {
    const { events, url } = await startServer();
    const response = await post(url, {
      body: JSON.stringify({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "hi" }),
    });
    expect(response).toEqual({ status: 200, body: "{}", type: "application/json" });
    await settle();
    expect(events).toEqual([
      expect.objectContaining({
        paneId: PANE,
        source: "claude",
        event: "Notification",
        notificationType: "permission_prompt",
      }),
    ]);
  });

  it("refuses the wrong token, method, Origin or Host without emitting", async () => {
    const { events, url } = await startServer();
    const body = JSON.stringify({ hook_event_name: "Stop" });
    const wrongToken = `/claude-hook/${"0".repeat(64)}`;

    expect((await post(url, { path: wrongToken, body })).status).toBe(404);
    expect((await post(url, { path: `${url.pathname}x`, body })).status).toBe(404);
    expect((await post(url, { path: "/", body })).status).toBe(404);
    expect((await post(url, { method: "GET" })).status).toBe(404);
    expect((await post(url, { body, headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await post(url, { body, headers: { host: `evil.example:${url.port}` } })).status).toBe(403);
    await settle();
    expect(events).toEqual([]);
  });

  it("answers but drops an event whose pane id is missing or malformed", async () => {
    const { events, url } = await startServer();
    const body = JSON.stringify({ hook_event_name: "Stop" });
    for (const pane of ["", "../etc", "a b", "$HT_PANE_ID", "x".repeat(65)]) {
      const response = await post(url, { body, headers: { "x-ht-pane": pane } });
      expect(response.status).toBe(200);
    }
    await settle();
    expect(events).toEqual([]);
  });

  it("survives a body bigger than the cap and still reports the event", async () => {
    const { events, url } = await startServer();
    const body = JSON.stringify({
      session_id: "s",
      hook_event_name: "PermissionRequest",
      tool_name: "Write",
      tool_input: { content: "w".repeat(2 * MAX_HOOK_BODY_BYTES) },
    });
    const response = await post(url, { body });
    expect(response.status).toBe(200);
    await settle();
    expect(events).toEqual([
      expect.objectContaining({ event: "PermissionRequest", toolName: "Write" }),
    ]);
  });

  it("hands out no settings to a Claude too old for HTTP hooks, and asks again later", async () => {
    let now = 1_000;
    const versions = ["2.1.80", "2.1.122"];
    const probe = vi.fn(async () => versions.shift() ?? null);
    const { server, userDataPath } = await startServer({ probe, now: () => now });

    expect(await server.getClaudeSettings(PANE)).toBeNull();
    expect(await server.getClaudeSettings(PANE)).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
    await expect(stat(paneFile(userDataPath, PANE))).rejects.toThrow();

    now += 60_000;
    expect(await server.getClaudeSettings(PANE)).not.toBeNull();
    now += 10 * 60_000;
    expect(await server.getClaudeSettings(PANE)).not.toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("hands out no settings when the version cannot be told", async () => {
    const { server } = await startServer({ version: null });
    expect(await server.getClaudeSettings(PANE)).toBeNull();
  });

  it("warms up the server and the version probe before the first pane asks", async () => {
    const userDataPath = await makeUserData();
    const probe = vi.fn(async () => "2.1.283");
    const server = new AgentHookServer({ userDataPath, probeClaudeVersion: probe });
    cleanup.push(() => server.close());
    await server.warmUp();
    expect(server.hookUrl).not.toBe("");
    expect(probe).toHaveBeenCalledOnce();
    await server.getClaudeSettings(PANE);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("stops routing and serving once closed", async () => {
    const { server, events, url } = await startServer();
    await server.close();
    expect(await server.getClaudeSettings(PANE)).toBeNull();
    await expect(post(url, { body: JSON.stringify({ hook_event_name: "Stop" }) })).rejects.toThrow();
    expect(events).toEqual([]);
  });
});
