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

  it("collapses the copies a --resume fork leaves behind, keeping the newest", async () => {
    const roots = await makeRoots();
    const cwd = "/home/dev/my-project";
    const dir = join(roots.claudeProjectsRoot, "-home-dev-my-project");
    await mkdir(dir, { recursive: true });

    // Resuming a conversation can replay its whole history into a brand new
    // session file: same opening record, new session id. Both files are real
    // transcripts on disk, but they are one conversation to the user.
    const opening = {
      type: "user",
      uuid: "opening-record-uuid",
      message: { content: "Audita o fluxo de assinatura do holerite" },
    };
    await writeFile(join(dir, "ancestor.jsonl"), JSON.stringify(opening));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(
      join(dir, "fork.jsonl"),
      [JSON.stringify(opening), JSON.stringify({ type: "user", uuid: "later", message: { content: "e agora?" } })].join("\n"),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(
      join(dir, "unrelated.jsonl"),
      JSON.stringify({ type: "user", uuid: "other-opening", message: { content: "outra conversa" } }),
    );

    const entries = await listResumableSessions(cwd, "claude", undefined, roots);
    expect(entries.map((entry) => entry.id)).toEqual(["unrelated", "fork"]);
  });

  it("keeps transcripts without an opening record id in the list instead of merging them", async () => {
    const roots = await makeRoots();
    const cwd = "/home/dev/my-project";
    const dir = join(roots.claudeProjectsRoot, "-home-dev-my-project");
    await mkdir(dir, { recursive: true });

    await writeFile(
      join(dir, "no-uuid-a.jsonl"),
      JSON.stringify({ type: "user", message: { content: "primeira" } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(
      join(dir, "no-uuid-b.jsonl"),
      JSON.stringify({ type: "user", message: { content: "segunda" } }),
    );

    const entries = await listResumableSessions(cwd, "claude", undefined, roots);
    expect(entries.map((entry) => entry.id)).toEqual(["no-uuid-b", "no-uuid-a"]);
  });

  it("re-titles conversations started from the same boilerplate prompt by what differs", async () => {
    const roots = await makeRoots();
    const cwd = "/home/dev/my-project";
    const dir = join(roots.claudeProjectsRoot, "-home-dev-my-project");
    await mkdir(dir, { recursive: true });

    // The part that tells these apart sits past TITLE_MAX_LENGTH, and they are
    // written within the same second — neither the title nor the timestamp can
    // separate them as they stand.
    const boilerplate =
      "Auditoria LGPD somente-leitura. Repo: /home/dev/my-project (admin-api, admin-ui, auth-api). ";
    await writeFile(
      join(dir, "audit-a.jsonl"),
      JSON.stringify({ type: "user", uuid: "a", message: { content: `${boilerplate}Checklist P-08 a P-13.` } }),
    );
    await writeFile(
      join(dir, "audit-b.jsonl"),
      JSON.stringify({ type: "user", uuid: "b", message: { content: `${boilerplate}Checklist P-19 a P-29.` } }),
    );

    const entries = await listResumableSessions(cwd, "claude", undefined, roots);
    const titles = entries.map((entry) => entry.title).sort();
    expect(titles).toEqual(["…P-08 a P-13.", "…P-19 a P-29."]);
  });

  it("keeps the original title when cutting the shared opening still leaves the rows identical", async () => {
    const roots = await makeRoots();
    const cwd = "/home/dev/my-project";
    const dir = join(roots.claudeProjectsRoot, "-home-dev-my-project");
    await mkdir(dir, { recursive: true });

    // The same briefing pasted twice, diverging only past the text a title is
    // built from: no cut can separate these, and a half-eaten title reads
    // worse than the full one. (The menu falls back to exact timestamps for
    // rows like these.)
    const briefing = `A ideia é executar todas as jornadas do superapp. ${"Revisa os mocks, a retenção de dados e cada tela do fluxo. ".repeat(8)}`;
    await writeFile(
      join(dir, "run-a.jsonl"),
      JSON.stringify({ type: "user", uuid: "a", message: { content: `${briefing} Começa pelo backend.` } }),
    );
    await writeFile(
      join(dir, "run-b.jsonl"),
      JSON.stringify({ type: "user", uuid: "b", message: { content: `${briefing} Começa pelo app.` } }),
    );

    const entries = await listResumableSessions(cwd, "claude", undefined, roots);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.title.startsWith("A ideia é executar")).toBe(true);
    }
  });

  it("leaves titles that already differ on screen untouched", async () => {
    const roots = await makeRoots();
    const cwd = "/home/dev/my-project";
    const dir = join(roots.claudeProjectsRoot, "-home-dev-my-project");
    await mkdir(dir, { recursive: true });

    // Same three opening words, then they part ways — the row shows enough to
    // tell them apart, so trimming would only throw context away.
    await writeFile(
      join(dir, "one.jsonl"),
      JSON.stringify({ type: "user", uuid: "1", message: { content: "no processo de holerite, revisa o cálculo do INSS" } }),
    );
    await writeFile(
      join(dir, "two.jsonl"),
      JSON.stringify({ type: "user", uuid: "2", message: { content: "no processo de holerite, quero mudar o layout do PDF" } }),
    );

    const entries = await listResumableSessions(cwd, "claude", undefined, roots);
    for (const entry of entries) {
      expect(entry.title.startsWith("no processo de holerite")).toBe(true);
    }
  });

  it("leaves same-titled conversations alone when they share nothing but a greeting", async () => {
    const roots = await makeRoots();
    const cwd = "/home/dev/my-project";
    const dir = join(roots.claudeProjectsRoot, "-home-dev-my-project");
    await mkdir(dir, { recursive: true });

    // Two throwaway chats opened with the same word: there is no boilerplate
    // to strip, so trimming it would leave the rows worse, not better.
    for (const name of ["greeting-a", "greeting-b"]) {
      await writeFile(
        join(dir, `${name}.jsonl`),
        JSON.stringify({ type: "user", uuid: name, message: { content: "teste" } }),
      );
    }

    const entries = await listResumableSessions(cwd, "claude", undefined, roots);
    expect(entries.map((entry) => entry.title)).toEqual(["teste", "teste"]);
  });

  it("never leaks the internal disambiguation fields across IPC", async () => {
    const roots = await makeRoots();
    const cwd = "/home/dev/my-project";
    const dir = join(roots.claudeProjectsRoot, "-home-dev-my-project");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "only.jsonl"),
      JSON.stringify({ type: "user", uuid: "u", message: { content: "oi" } }),
    );

    const entries = await listResumableSessions(cwd, "claude", undefined, roots);
    expect(Object.keys(entries[0]).sort()).toEqual(["id", "title", "updatedAt"]);
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
