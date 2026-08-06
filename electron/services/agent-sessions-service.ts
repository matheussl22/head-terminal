import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ResumableSessionEntry } from "../types/api";

const MAX_ENTRIES = 20;
const CLAUDE_TITLE_SCAN_LINES = 50;
const CODEX_MAX_CANDIDATE_FILES = 300;
const TITLE_MAX_LENGTH = 80;

export interface AgentSessionRoots {
  claudeProjectsRoot: string;
  codexRoot: string;
  cursorProjectsRoot: string;
}

/** Overridable in tests so nothing here ever touches the real `$HOME`. */
function defaultRoots(): AgentSessionRoots {
  return {
    claudeProjectsRoot: join(homedir(), ".claude", "projects"),
    codexRoot: join(homedir(), ".codex"),
    cursorProjectsRoot: join(homedir(), ".cursor", "projects"),
  };
}

// Scaffolding injected around the user's actual text in Claude/Cursor
// transcripts. Caveats/slash-command echoes/timestamps carry no title-worthy
// content, so the whole block (tag + content) is dropped; user_query only
// wraps the real question, so just its tag markers are stripped.
const STRIP_BLOCK_TAG =
  /<(local-command-caveat|command-name|command-message|command-args|timestamp)>[\s\S]*?<\/\1>/gi;
const STRIP_TAG_ONLY = /<\/?user_query[^>]*>/gi;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cleanTitleText(raw: string): string {
  return raw
    .replace(STRIP_BLOCK_TAG, " ")
    .replace(STRIP_TAG_ONLY, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatFallbackTitle(ms: number): string {
  return `Sessão de ${new Date(ms).toLocaleString("pt-BR")}`;
}

/** Reads at most `maxLines` lines without loading the rest of a (possibly
 * large) transcript file into memory. */
async function readFirstLines(filePath: string, maxLines: number): Promise<string[]> {
  const lines: string[] = [];
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line) lines.push(line);
      if (lines.length >= maxLines) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return lines;
}

function firstTextBlock(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const block = content.find(
      (item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text",
    ) as { text?: unknown } | undefined;
    if (typeof block?.text === "string") return block.text;
  }
  return undefined;
}

// --- Claude: ~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl ---

function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

async function extractClaudeTitle(filePath: string): Promise<string | null> {
  const lines = await readFirstLines(filePath, CLAUDE_TITLE_SCAN_LINES);
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = parsed as {
      type?: string;
      isMeta?: boolean;
      message?: { content?: unknown };
    };
    if (record.type !== "user" || record.isMeta === true) continue;
    const text = firstTextBlock(record.message?.content);
    if (typeof text !== "string") continue;
    const cleaned = cleanTitleText(text);
    if (cleaned) return truncate(cleaned, TITLE_MAX_LENGTH);
  }
  return null;
}

async function listClaudeSessions(
  cwd: string,
  claudeProjectsRoot: string,
  claudeConfigDir?: string,
): Promise<ResumableSessionEntry[]> {
  // Isolated Claude account profiles (see src/core/claude-accounts.ts) keep
  // their own CLAUDE_CONFIG_DIR, so their transcripts live under
  // <configDir>/projects rather than the default ~/.claude/projects — using
  // the wrong root either lists the wrong account's history or an id that
  // doesn't exist under this pane's config dir, and --resume fails.
  const root = claudeConfigDir ? join(claudeConfigDir, "projects") : claudeProjectsRoot;
  const dir = join(root, encodeClaudeProjectDir(cwd));
  let files;
  try {
    files = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }

  const candidates = (
    await Promise.all(
      files
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(async (entry) => {
          const path = join(dir, entry.name);
          const info = await stat(path).catch(() => null);
          if (!info) return null;
          return { id: entry.name.slice(0, -".jsonl".length), path, mtime: info.mtimeMs };
        }),
    )
  )
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_ENTRIES);

  return Promise.all(
    candidates.map(async (candidate) => ({
      id: candidate.id,
      title: (await extractClaudeTitle(candidate.path).catch(() => null))
        ?? formatFallbackTitle(candidate.mtime),
      updatedAt: new Date(candidate.mtime).toISOString(),
    })),
  );
}

// --- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl + session_index.jsonl ---

async function readCodexIndex(
  codexRoot: string,
): Promise<Map<string, { threadName?: string; updatedAt?: string }>> {
  const indexPath = join(codexRoot, "session_index.jsonl");
  const index = new Map<string, { threadName?: string; updatedAt?: string }>();
  let content: string;
  try {
    content = await readFile(indexPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return index;
    throw error;
  }
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { id?: unknown; thread_name?: unknown; updated_at?: unknown };
      if (typeof parsed.id === "string") {
        index.set(parsed.id, {
          threadName: typeof parsed.thread_name === "string" ? parsed.thread_name : undefined,
          updatedAt: typeof parsed.updated_at === "string" ? parsed.updated_at : undefined,
        });
      }
    } catch {
      // skip malformed index line
    }
  }
  return index;
}

/** Walks sessions/YYYY/MM/DD newest-first, stopping once `limit` files have
 * been collected so a year of history doesn't turn every click into a full
 * filesystem sweep. */
async function collectCodexRolloutFiles(
  codexRoot: string,
  limit: number,
): Promise<Array<{ path: string; mtime: number }>> {
  const root = join(codexRoot, "sessions");
  const results: Array<{ path: string; mtime: number }> = [];

  const listDescending = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  };

  for (const year of await listDescending(root)) {
    for (const month of await listDescending(join(root, year))) {
      for (const day of await listDescending(join(root, year, month))) {
        const dayDir = join(root, year, month, day);
        const files = await readdir(dayDir, { withFileTypes: true }).catch(() => []);
        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
          const path = join(dayDir, file.name);
          const info = await stat(path).catch(() => null);
          if (info) results.push({ path, mtime: info.mtimeMs });
        }
        if (results.length >= limit) return results;
      }
      if (results.length >= limit) return results;
    }
    if (results.length >= limit) return results;
  }
  return results;
}

async function readCodexSessionMeta(filePath: string): Promise<{ id: string; cwd: string } | null> {
  const [firstLine] = await readFirstLines(filePath, 1);
  if (!firstLine) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return null;
  }
  const record = parsed as { type?: string; payload?: { id?: unknown; session_id?: unknown; cwd?: unknown } };
  if (record.type !== "session_meta" || !record.payload) return null;
  const id = record.payload.id ?? record.payload.session_id;
  if (typeof id !== "string" || typeof record.payload.cwd !== "string") return null;
  return { id, cwd: record.payload.cwd };
}

async function listCodexSessions(
  cwd: string,
  codexRoot: string,
): Promise<ResumableSessionEntry[]> {
  const [files, index] = await Promise.all([
    collectCodexRolloutFiles(codexRoot, CODEX_MAX_CANDIDATE_FILES),
    readCodexIndex(codexRoot),
  ]);

  const matches: Array<{ id: string; title: string; effectiveMs: number }> = [];
  for (const file of files) {
    const meta = await readCodexSessionMeta(file.path).catch(() => null);
    if (!meta || meta.cwd !== cwd) continue;
    const indexed = index.get(meta.id);
    // Sort key must match what gets displayed — mixing the index's
    // updated_at with the file's own mtime produces a list that looks
    // out of order even though each half is individually sorted.
    const indexedMs = indexed?.updatedAt ? Date.parse(indexed.updatedAt) : NaN;
    const effectiveMs = Number.isNaN(indexedMs) ? file.mtime : indexedMs;
    matches.push({
      id: meta.id,
      title: indexed?.threadName?.trim() || formatFallbackTitle(effectiveMs),
      effectiveMs,
    });
  }

  return matches
    .sort((a, b) => b.effectiveMs - a.effectiveMs)
    .slice(0, MAX_ENTRIES)
    .map(({ id, title, effectiveMs }) => ({
      id,
      title,
      updatedAt: new Date(effectiveMs).toISOString(),
    }));
}

// --- Cursor: ~/.cursor/projects/<cwd-encoded>/agent-transcripts/<chatId>/<chatId>.jsonl ---

function encodeCursorProjectDir(cwd: string): string {
  return cwd.split("/").filter(Boolean).join("-").replace(/\./g, "-");
}

async function extractCursorTitle(filePath: string): Promise<string | null> {
  const [firstLine] = await readFirstLines(filePath, 1);
  if (!firstLine) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return null;
  }
  const text = firstTextBlock((parsed as { message?: { content?: unknown } }).message?.content);
  if (typeof text !== "string") return null;
  const cleaned = cleanTitleText(text);
  return cleaned ? truncate(cleaned, TITLE_MAX_LENGTH) : null;
}

async function listCursorSessions(
  cwd: string,
  cursorProjectsRoot: string,
): Promise<ResumableSessionEntry[]> {
  const dir = join(cursorProjectsRoot, encodeCursorProjectDir(cwd), "agent-transcripts");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }

  const candidates = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = join(dir, entry.name, `${entry.name}.jsonl`);
          const info = await stat(path).catch(() => null);
          if (!info) return null;
          return { id: entry.name, path, mtime: info.mtimeMs };
        }),
    )
  )
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_ENTRIES);

  return Promise.all(
    candidates.map(async (candidate) => ({
      id: candidate.id,
      title: (await extractCursorTitle(candidate.path).catch(() => null))
        ?? formatFallbackTitle(candidate.mtime),
      updatedAt: new Date(candidate.mtime).toISOString(),
    })),
  );
}

// --- Dispatch ---

/** Best-effort by design: a resumable-sessions lookup must never block or
 * break a pane restart, so any unexpected failure degrades to "no sessions"
 * instead of surfacing an error to the renderer. */
export async function listResumableSessions(
  cwd: string,
  agent: string,
  claudeConfigDir?: string,
  roots: AgentSessionRoots = defaultRoots(),
): Promise<ResumableSessionEntry[]> {
  if (!cwd || cwd.includes("\0")) return [];
  try {
    switch (agent) {
      case "claude":
        return await listClaudeSessions(cwd, roots.claudeProjectsRoot, claudeConfigDir);
      case "codex":
        return await listCodexSessions(cwd, roots.codexRoot);
      case "cursor":
        return await listCursorSessions(cwd, roots.cursorProjectsRoot);
      default:
        return [];
    }
  } catch (error) {
    console.error("Failed to list resumable sessions", { agent, error });
    return [];
  }
}
