import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listResumableSessions, type AgentSessionRoots } from "./agent-sessions-service";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function makeRoots(): Promise<AgentSessionRoots> {
  const root = await mkdtemp(join(tmpdir(), "ht-agent-sessions-"));
  cleanup.push(root);
  return {
    claudeProjectsRoot: join(root, "claude-projects"),
    codexRoot: join(root, "codex"),
    cursorProjectsRoot: join(root, "cursor-projects"),
  };
}

describe("agent-sessions-service", () => {
  it("returns [] for an unknown agent, empty cwd, or missing project dir", async () => {
    const roots = await makeRoots();
    await expect(listResumableSessions("/tmp/proj", "shell", undefined, roots)).resolves.toEqual([]);
    await expect(listResumableSessions("", "claude", undefined, roots)).resolves.toEqual([]);
    await expect(listResumableSessions("/tmp/proj", "claude", undefined, roots)).resolves.toEqual([]);
  });

  it("lists Claude sessions for the matching cwd, newest first, with a derived title", async () => {
    const roots = await makeRoots();
    const cwd = "/home/dev/my.project";
    const dir = join(roots.claudeProjectsRoot, "-home-dev-my-project");
    await mkdir(dir, { recursive: true });

    await writeFile(
      join(dir, "older-session.jsonl"),
      [
        JSON.stringify({ type: "mode", mode: "normal" }),
        JSON.stringify({
          type: "user",
          isMeta: true,
          message: { content: "<local-command-caveat>ignore me</local-command-caveat>" },
        }),
        JSON.stringify({
          type: "user",
          message: { content: "Explain how the pty bridge reconnects after a crash" },
        }),
      ].join("\n"),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(
      join(dir, "newer-session.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: { content: "  Add a resume dropdown next to the restart button  " },
        }),
      ].join("\n"),
    );

    const entries = await listResumableSessions(cwd, "claude", undefined, roots);
    expect(entries.map((entry) => entry.id)).toEqual(["newer-session", "older-session"]);
    expect(entries[0].title).toBe("Add a resume dropdown next to the restart button");
    expect(entries[1].title).toBe("Explain how the pty bridge reconnects after a crash");
  });

  it("reads Claude sessions from the account's own configDir/projects instead of the default root", async () => {
    const roots = await makeRoots();
    const cwd = "/home/dev/my-project";

    // Default account has a session for this cwd...
    const defaultDir = join(roots.claudeProjectsRoot, "-home-dev-my-project");
    await mkdir(defaultDir, { recursive: true });
    await writeFile(
      join(defaultDir, "default-account-session.jsonl"),
      JSON.stringify({ type: "user", message: { content: "personal account chat" } }),
    );

    // ...but a work profile keeps an isolated CLAUDE_CONFIG_DIR with its own
    // (different) session for the same cwd.
    const workConfigDir = join(roots.claudeProjectsRoot, "..", "work-profile");
    const workDir = join(workConfigDir, "projects", "-home-dev-my-project");
    await mkdir(workDir, { recursive: true });
    await writeFile(
      join(workDir, "work-account-session.jsonl"),
      JSON.stringify({ type: "user", message: { content: "work account chat" } }),
    );

    const defaultEntries = await listResumableSessions(cwd, "claude", undefined, roots);
    expect(defaultEntries.map((entry) => entry.id)).toEqual(["default-account-session"]);

    const workEntries = await listResumableSessions(cwd, "claude", workConfigDir, roots);
    expect(workEntries.map((entry) => entry.id)).toEqual(["work-account-session"]);
  });

  it("lists Codex sessions filtered by cwd, using the thread_name index for the title", async () => {
    const roots = await makeRoots();
    const cwd = "/home/dev/my-project";
    const dayDir = join(roots.codexRoot, "sessions", "2026", "07", "23");
    await mkdir(dayDir, { recursive: true });

    await writeFile(
      join(dayDir, "rollout-2026-07-23T00-00-00-match-id.jsonl"),
      JSON.stringify({
        type: "session_meta",
        payload: { id: "match-id", cwd },
      }),
    );
    await writeFile(
      join(dayDir, "rollout-2026-07-23T00-00-01-other-cwd-id.jsonl"),
      JSON.stringify({
        type: "session_meta",
        payload: { id: "other-cwd-id", cwd: "/somewhere/else" },
      }),
    );
    await writeFile(
      join(roots.codexRoot, "session_index.jsonl"),
      JSON.stringify({ id: "match-id", thread_name: "fix-pty-reconnect", updated_at: "2026-07-23T00:00:00Z" }),
    );

    const entries = await listResumableSessions(cwd, "codex", undefined, roots);
    expect(entries).toEqual([
      { id: "match-id", title: "fix-pty-reconnect", updatedAt: "2026-07-23T00:00:00.000Z" },
    ]);
  });

  it("sorts Codex sessions by the same timestamp it displays, even when file mtime and the index disagree", async () => {
    const roots = await makeRoots();
    const cwd = "/home/dev/my-project";
    const dayDir = join(roots.codexRoot, "sessions", "2026", "07", "23");
    await mkdir(dayDir, { recursive: true });

    // Written to disk in this order (so file mtime says "older" is newer),
    // but the index says otherwise — the index's updated_at must win.
    await writeFile(
      join(dayDir, "rollout-older-by-index.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: "older-by-index", cwd } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(
      join(dayDir, "rollout-newer-by-index.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: "newer-by-index", cwd } }),
    );
    await writeFile(
      join(roots.codexRoot, "session_index.jsonl"),
      [
        JSON.stringify({ id: "older-by-index", updated_at: "2020-01-01T00:00:00Z" }),
        JSON.stringify({ id: "newer-by-index", updated_at: "2030-01-01T00:00:00Z" }),
      ].join("\n"),
    );

    const entries = await listResumableSessions(cwd, "codex", undefined, roots);
    expect(entries.map((entry) => entry.id)).toEqual(["newer-by-index", "older-by-index"]);
  });

  it("lists Cursor sessions from agent-transcripts, stripping timestamp/user_query tags from the title", async () => {
    const roots = await makeRoots();
    const cwd = "/home/dev/my-project";
    const chatId = "chat-123";
    const dir = join(roots.cursorProjectsRoot, "home-dev-my-project", "agent-transcripts", chatId);
    await mkdir(dir, { recursive: true });

    await writeFile(
      join(dir, `${chatId}.jsonl`),
      JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<timestamp>Thursday, Aug 6, 2026</timestamp>\n<user_query>\nExplore the repo\n</user_query>",
            },
          ],
        },
      }),
    );

    const entries = await listResumableSessions(cwd, "cursor", undefined, roots);
    expect(entries).toEqual([
      { id: chatId, title: "Explore the repo", updatedAt: expect.any(String) },
    ]);
  });

  it("falls back to a formatted timestamp when no usable title text is found", async () => {
    const roots = await makeRoots();
    const cwd = "/home/dev/empty-title";
    const dir = join(roots.claudeProjectsRoot, "-home-dev-empty-title");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "no-title.jsonl"),
      JSON.stringify({ type: "user", message: { content: "<command-name>/clear</command-name>" } }),
    );

    const entries = await listResumableSessions(cwd, "claude", undefined, roots);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toMatch(/^Sessão de /u);
  });
});
