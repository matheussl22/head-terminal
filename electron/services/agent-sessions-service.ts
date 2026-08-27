import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ResumableSessionEntry } from "../types/api";
import { toPosixPath } from "./wsl-service";
import { TITLE_MAX_LENGTH, summarizeTitle } from "./session-title";

const MAX_ENTRIES = 20;
const CLAUDE_TITLE_SCAN_LINES = 50;
const CODEX_MAX_CANDIDATE_FILES = 300;
// The user's first prompt only comes after the CLI's own header records
// (instructions, permissions, environment), so the scan has to reach past them.
const CODEX_TITLE_SCAN_LINES = 40;
// A fork is only visible after its file's head has been read, so a few extra
// candidates are inspected — otherwise collapsing the copies would leave the
// list shorter than MAX_ENTRIES.
const CLAUDE_MAX_CANDIDATE_FILES = MAX_ENTRIES * 2;
// Kept past the title itself so conversations opened with the same pasted
// prompt can still be told apart (see disambiguateTitles).
const TITLE_SOURCE_MAX_LENGTH = 400;
// Roughly how much of a title a row shows before the ellipsis takes over.
// Two conversations that differ before this are already telling themselves
// apart; only a shared opening at least this long makes rows unreadable, and
// only that much is ever worth cutting away.
const AMBIGUOUS_PREFIX_CHARS = 36;
// Boilerplate nests: cutting "Auditoria LGPD. Repo: " off four prompts leaves
// four rows all starting with the same repo path. Each pass cuts one layer.
const DISAMBIGUATION_MAX_PASSES = 4;

export interface AgentSessionRoots {
  claudeProjectsRoot: string;
  codexRoot: string;
  cursorProjectsRoot: string;
}

/** Linux `$HOME` (UNC on Windows) or the native homedir. Extracted so a
 * WSL pane's transcripts are not looked up under `C:\Users\...` while the
 * CLI writes them to `/root/.claude`. */
export function resolveAgentSessionRoots(options: {
  posixHome: string | null;
  toWindowsPath?: (posix: string) => string;
  nativeHome?: string;
}): AgentSessionRoots {
  const nativeHome = options.nativeHome ?? homedir();
  const posixHome = options.posixHome;
  const toWindowsPath = options.toWindowsPath;
  const base = posixHome
    ? (suffix: string) => {
        const posix = `${posixHome}${suffix}`;
        return toWindowsPath ? toWindowsPath(posix) : posix;
      }
    : (suffix: string) => join(nativeHome, ...suffix.slice(1).split("/"));
  return {
    claudeProjectsRoot: base("/.claude/projects"),
    codexRoot: base("/.codex"),
    cursorProjectsRoot: base("/.cursor/projects"),
  };
}

/** Overridable in tests so nothing here ever touches the real `$HOME`. */
function defaultRoots(): AgentSessionRoots {
  return resolveAgentSessionRoots({ posixHome: null });
}

// Scaffolding injected around the user's actual text in Claude/Cursor
// transcripts. Caveats/slash-command echoes/timestamps carry no title-worthy
// content, so the whole block (tag + content) is dropped; user_query only
// wraps the real question, so just its tag markers are stripped.
const STRIP_BLOCK_TAG =
  /<(local-command-caveat|command-name|command-message|command-args|timestamp)>[\s\S]*?<\/\1>/gi;
// A command's output can be longer than the window the head scan reads, so
// its closing tag may never show up — dropping to the end of what was read is
// what keeps a "Set model to Sonnet" echo from becoming a conversation's name.
const STRIP_OUTPUT_BLOCK =
  /<(local-command-stdout|local-command-stderr)>[\s\S]*?(?:<\/\1>|$)/gi;
const STRIP_TAG_ONLY = /<\/?user_query[^>]*>/gi;
// Attachment placeholders: they say a screenshot was pasted, never what for.
const STRIP_ATTACHMENT = /\[(?:image|imagem|screenshot)(?:\s*#\d+)?\]/gi;
const STRIP_ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cleanTitleText(raw: string): string {
  return raw
    .replace(STRIP_OUTPUT_BLOCK, " ")
    .replace(STRIP_BLOCK_TAG, " ")
    .replace(STRIP_TAG_ONLY, " ")
    .replace(STRIP_ATTACHMENT, " ")
    .replace(STRIP_ANSI, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatFallbackTitle(ms: number): string {
  return `Sessão de ${new Date(ms).toLocaleString("pt-BR")}`;
}

/** A listed session before the list is handed to the renderer: carries the
 * extra context the collapse/disambiguate passes need, none of which crosses
 * the IPC boundary. `fromTranscript` is derived from `titleSource` only in
 * `toResumableEntry`. */
interface DraftEntry {
  id: string;
  title: string;
  updatedAt: string;
  /** Cleaned opening message, longer than the title. */
  titleSource?: string;
  /** Id of the transcript's opening record. A `--resume` can copy the whole
   * history into a brand new session file, and every copy keeps this same
   * value — it is what tells a fork apart from a genuinely new conversation. */
  rootUuid?: string;
}

function toResumableEntry(entry: DraftEntry): ResumableSessionEntry {
  return {
    id: entry.id,
    title: entry.title,
    updatedAt: entry.updatedAt,
    fromTranscript: Boolean(entry.titleSource),
  };
}

/** Drops the older copies a `--resume` fork leaves behind, keeping the newest
 * one — the list is already sorted newest-first, and the newest copy is the
 * one the CLI is actually appending to. */
function collapseForkCopies(entries: DraftEntry[]): DraftEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (!entry.rootUuid || seen.has(entry.rootUuid)) {
      return !entry.rootUuid;
    }
    seen.add(entry.rootUuid);
    return true;
  });
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

/** Prefer cutting on a word boundary, then on a path/url separator, and only
 * mid-token as a last resort: prompts that open with the same long url or
 * repo path have no spaces to snap back to, and those are exactly the ones
 * that need cutting. */
function cutPoint(text: string, shared: number): number {
  for (const boundary of [/\s/u, /[\s/\\:.,;-]/u]) {
    let index = shared;
    while (index > 0 && !boundary.test(text[index - 1])) index -= 1;
    if (index >= AMBIGUOUS_PREFIX_CHARS) return index;
  }
  return shared;
}

/** Sorted texts sharing a long opening. Lexicographic order puts them next to
 * each other, and for sorted strings the whole run's common prefix is the
 * smallest of its adjacent ones — so neighbours passing the threshold is
 * enough to know the run as a whole does. */
function clusterBySharedOpening(sorted: DraftEntry[], text: (entry: DraftEntry) => string): DraftEntry[][] {
  const clusters: DraftEntry[][] = [];
  let current: DraftEntry[] = [];
  for (const entry of sorted) {
    const previous = current[current.length - 1];
    if (
      previous
      && commonPrefixLength(text(previous), text(entry)) >= AMBIGUOUS_PREFIX_CHARS
    ) {
      current.push(entry);
      continue;
    }
    if (current.length > 1) clusters.push(current);
    current = [entry];
  }
  if (current.length > 1) clusters.push(current);
  return clusters;
}

/**
 * Fans out a batch of conversations started from the same boilerplate prompt
 * — an audit split across panes, a template pasted five times — into rows the
 * user can tell apart. Their titles are identical because they get cut before
 * the part that differs ("…checklist P-19 a P-29"), so the shared opening is
 * what gets cut instead. Timestamps can't do this job: those runs are started
 * seconds apart, sometimes inside the same second.
 */
function disambiguateTitles(entries: DraftEntry[]): DraftEntry[] {
  const offsets = new Map<string, number>();
  const remainder = (entry: DraftEntry) =>
    (entry.titleSource ?? "").slice(offsets.get(entry.id) ?? 0);

  const candidates = entries.filter((entry) => entry.titleSource);
  for (let pass = 0; pass < DISAMBIGUATION_MAX_PASSES; pass += 1) {
    const sorted = [...candidates].sort((a, b) =>
      remainder(a) < remainder(b) ? -1 : remainder(a) > remainder(b) ? 1 : 0,
    );

    let cutSomething = false;
    for (const cluster of clusterBySharedOpening(sorted, remainder)) {
      const shared = cluster
        .slice(1)
        .reduce(
          (least, entry, index) =>
            Math.min(least, commonPrefixLength(remainder(cluster[index]), remainder(entry))),
          Number.POSITIVE_INFINITY,
        );
      const cut = cutPoint(remainder(cluster[0]), shared);
      if (cut < AMBIGUOUS_PREFIX_CHARS) continue;

      for (const entry of cluster) {
        // Leading punctuation left behind by the cut ("…. Checklist" from a
        // shared path) is noise, not content.
        const rest = remainder(entry).slice(cut).replace(/^[\s\p{P}]+/u, "");
        // Nothing left to show: this conversation's opening *is* the shared
        // text, so it keeps the common title rather than an empty row.
        if (!rest) continue;
        offsets.set(
          entry.id,
          (entry.titleSource as string).length - rest.length,
        );
        cutSomething = true;
      }
    }

    if (!cutSomething) break;
  }

  // Prompts that only diverge past TITLE_SOURCE_MAX_LENGTH can't be separated
  // no matter how much is cut, and a half-eaten title ("…https://integritas")
  // is worse than the original: those rows go back to what they were and let
  // the menu fall back to exact timestamps.
  const stillAmbiguous = new Set<string>();
  const byVisible = new Map<string, DraftEntry[]>();
  for (const entry of candidates) {
    const visible = remainder(entry).slice(0, AMBIGUOUS_PREFIX_CHARS);
    const peers = byVisible.get(visible);
    if (peers) peers.push(entry);
    else byVisible.set(visible, [entry]);
  }
  for (const peers of byVisible.values()) {
    if (peers.length > 1) {
      for (const entry of peers) stillAmbiguous.add(entry.id);
    }
  }

  for (const entry of candidates) {
    const offset = offsets.get(entry.id);
    if (offset && !stillAmbiguous.has(entry.id)) {
      entry.title = truncate(`…${remainder(entry)}`, TITLE_MAX_LENGTH);
    }
  }

  return entries;
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
      (item) =>
        item
        && typeof item === "object"
        && ((item as { type?: unknown }).type === "text"
          || (item as { type?: unknown }).type === "input_text"),
    ) as { text?: unknown } | undefined;
    if (typeof block?.text === "string") return block.text;
  }
  return undefined;
}

/**
 * Both Claude and Cursor flatten the cwd into a single directory name, and the
 * encoders below reproduce each scheme — but only as a first guess, because on
 * Windows the CLIs are not consistent about the drive letter's case (`C-Users-x`
 * and `c-Users-x` sit side by side in the same root). A guess that misses is
 * indistinguishable from "this cwd has no conversations", which is what used to
 * leave every pane on Windows unable to anchor: no anchor persisted, and every
 * restart opening a blank conversation instead of resuming.
 */
function cwdLookupSpellings(cwd: string): string[] {
  const posix = toPosixPath(cwd);
  return [...new Set([cwd, cwd.replaceAll("\\", "/"), posix])];
}

async function resolveEncodedProjectDir(
  root: string,
  cwd: string,
  encode: (cwd: string) => string,
): Promise<string | null> {
  const encodings = [...new Set(cwdLookupSpellings(cwd).map(encode))];
  for (const encoded of encodings) {
    const dir = await resolveProjectDir(root, encoded);
    if (dir) return dir;
  }
  return null;
}

async function resolveProjectDir(
  root: string,
  encoded: string,
): Promise<string | null> {
  const exact = join(root, encoded);
  try {
    await stat(exact);
    return exact;
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }

  const wanted = encoded.toLowerCase();
  const match = entries.find(
    (entry) => entry.isDirectory() && entry.name.toLowerCase() === wanted,
  );
  return match ? join(root, match.name) : null;
}

// --- Claude: ~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl ---

/** `C:\Users\me` -> `C--Users-me`, `/home/dev/my.app` -> `-home-dev-my-app`.
 * The drive colon and the backslash are separators here just like `/` is. */
function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[/\\.:]/g, "-");
}

interface ClaudeHead {
  /** Opening message, cleaned and capped at TITLE_SOURCE_MAX_LENGTH. */
  titleSource?: string;
  rootUuid?: string;
}

/** One pass over the head of a transcript for both things the list needs from
 * it: what to call the conversation, and which conversation it descends from. */
async function readClaudeHead(filePath: string): Promise<ClaudeHead> {
  const lines = await readFirstLines(filePath, CLAUDE_TITLE_SCAN_LINES);
  const head: ClaudeHead = {};
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = parsed as {
      type?: string;
      uuid?: unknown;
      isMeta?: boolean;
      message?: { content?: unknown };
    };
    if (!head.rootUuid && typeof record.uuid === "string" && record.uuid) {
      head.rootUuid = record.uuid;
    }
    if (head.titleSource) continue;
    if (record.type !== "user" || record.isMeta === true) continue;
    const text = firstTextBlock(record.message?.content);
    if (typeof text !== "string") continue;
    const cleaned = cleanTitleText(text);
    if (cleaned) head.titleSource = truncate(cleaned, TITLE_SOURCE_MAX_LENGTH);
  }
  return head;
}

async function listClaudeSessions(
  cwd: string,
  claudeProjectsRoot: string,
  claudeConfigDir?: string,
): Promise<DraftEntry[]> {
  // Isolated Claude account profiles (see src/core/claude-accounts.ts) keep
  // their own CLAUDE_CONFIG_DIR, so their transcripts live under
  // <configDir>/projects rather than the default ~/.claude/projects — using
  // the wrong root either lists the wrong account's history or an id that
  // doesn't exist under this pane's config dir, and --resume fails.
  const root = claudeConfigDir ? join(claudeConfigDir, "projects") : claudeProjectsRoot;
  const dir = await resolveEncodedProjectDir(
    root,
    cwd,
    encodeClaudeProjectDir,
  );
  if (!dir) return [];

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
    .slice(0, CLAUDE_MAX_CANDIDATE_FILES);

  const drafts = await Promise.all(
    candidates.map(async (candidate) => {
      const head = await readClaudeHead(candidate.path).catch(
        (): ClaudeHead => ({}),
      );
      return {
        id: candidate.id,
        title: head.titleSource
          ? summarizeTitle(head.titleSource)
          : formatFallbackTitle(candidate.mtime),
        updatedAt: new Date(candidate.mtime).toISOString(),
        titleSource: head.titleSource,
        rootUuid: head.rootUuid,
      };
    }),
  );

  return collapseForkCopies(drafts).slice(0, MAX_ENTRIES);
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

/** Prompts the CLI injects before the user gets to type: naming a session
 * after one of these would give every Codex conversation the same title. */
const CODEX_INJECTED_PROMPT =
  /^\s*(?:<(?:environment_context|user_instructions|permissions)|#\s*AGENTS\.md)/iu;

/** Codex only names a session once the user runs `/name`, so most rollouts
 * would show up as a bare timestamp. The opening prompt is a better name, and
 * it sits a few records past the header the CLI writes first. */
async function readCodexTitleSource(filePath: string): Promise<string | undefined> {
  const lines = await readFirstLines(filePath, CODEX_TITLE_SCAN_LINES);
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = (parsed as { payload?: { type?: unknown; role?: unknown; content?: unknown } })
      .payload;
    if (payload?.type !== "message" || payload.role !== "user") continue;
    const text = firstTextBlock(payload.content);
    if (typeof text !== "string" || CODEX_INJECTED_PROMPT.test(text)) continue;
    const cleaned = cleanTitleText(text);
    if (cleaned) return truncate(cleaned, TITLE_SOURCE_MAX_LENGTH);
  }
  return undefined;
}

async function listCodexSessions(
  cwd: string,
  codexRoot: string,
): Promise<DraftEntry[]> {
  const [files, index] = await Promise.all([
    collectCodexRolloutFiles(codexRoot, CODEX_MAX_CANDIDATE_FILES),
    readCodexIndex(codexRoot),
  ]);

  const matches: Array<{
    id: string;
    path: string;
    threadName?: string;
    effectiveMs: number;
  }> = [];
  for (const file of files) {
    const meta = await readCodexSessionMeta(file.path).catch(() => null);
    if (!meta || toPosixPath(meta.cwd) !== toPosixPath(cwd)) continue;
    const indexed = index.get(meta.id);
    // Sort key must match what gets displayed — mixing the index's
    // updated_at with the file's own mtime produces a list that looks
    // out of order even though each half is individually sorted.
    const indexedMs = indexed?.updatedAt ? Date.parse(indexed.updatedAt) : NaN;
    const effectiveMs = Number.isNaN(indexedMs) ? file.mtime : indexedMs;
    matches.push({
      id: meta.id,
      path: file.path,
      threadName: indexed?.threadName?.trim() || undefined,
      effectiveMs,
    });
  }

  // Only the rows that make the list are worth a second pass over their file.
  return Promise.all(
    matches
      .sort((a, b) => b.effectiveMs - a.effectiveMs)
      .slice(0, MAX_ENTRIES)
      .map(async (match) => {
        // A `/name` from the index already is the title; otherwise scan for
        // the first real prompt. Either one must set titleSource so
        // fromTranscript stays true (timestamp fallbacks stay unnamed).
        const titleSource = match.threadName
          ?? await readCodexTitleSource(match.path).catch(() => undefined);
        return {
          id: match.id,
          title: match.threadName
            ?? (titleSource
              ? summarizeTitle(titleSource)
              : formatFallbackTitle(match.effectiveMs)),
          updatedAt: new Date(match.effectiveMs).toISOString(),
          titleSource,
        };
      }),
  );
}

// --- Cursor: ~/.cursor/projects/<cwd-encoded>/agent-transcripts/<chatId>/<chatId>.jsonl ---

/** `C:\Users\me` -> `C-Users-me`, `/home/dev/my.app` -> `home-dev-my-app`.
 * Unlike Claude, Cursor drops the drive colon rather than turning it into
 * another separator. */
function encodeCursorProjectDir(cwd: string): string {
  return cwd
    .split(/[/\\]/u)
    .filter(Boolean)
    .join("-")
    .replaceAll(":", "")
    .replace(/\./g, "-");
}

async function readCursorTitleSource(filePath: string): Promise<string | null> {
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
  return cleaned ? truncate(cleaned, TITLE_SOURCE_MAX_LENGTH) : null;
}

async function listCursorSessions(
  cwd: string,
  cursorProjectsRoot: string,
): Promise<DraftEntry[]> {
  const projectDir = await resolveEncodedProjectDir(
    cursorProjectsRoot,
    cwd,
    encodeCursorProjectDir,
  );
  if (!projectDir) return [];

  const dir = join(projectDir, "agent-transcripts");
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
    candidates.map(async (candidate) => {
      const titleSource = await readCursorTitleSource(candidate.path).catch(
        () => null,
      );
      return {
        id: candidate.id,
        title: titleSource
          ? summarizeTitle(titleSource)
          : formatFallbackTitle(candidate.mtime),
        updatedAt: new Date(candidate.mtime).toISOString(),
        titleSource: titleSource ?? undefined,
      };
    }),
  );
}

// --- Dispatch ---

/** Best-effort by design: a resumable-sessions lookup must never block or
 * break a pane restart, so any unexpected failure degrades to "no sessions"
 * instead of surfacing an error to the renderer. */
async function listDrafts(
  cwd: string,
  agent: string,
  roots: AgentSessionRoots,
  claudeConfigDir?: string,
): Promise<DraftEntry[]> {
  switch (agent) {
    case "claude":
      return listClaudeSessions(cwd, roots.claudeProjectsRoot, claudeConfigDir);
    case "codex":
      return listCodexSessions(cwd, roots.codexRoot);
    case "cursor":
      return listCursorSessions(cwd, roots.cursorProjectsRoot);
    default:
      return [];
  }
}

export async function listResumableSessions(
  cwd: string,
  agent: string,
  claudeConfigDir?: string,
  roots: AgentSessionRoots = defaultRoots(),
): Promise<ResumableSessionEntry[]> {
  if (!cwd || cwd.includes("\0")) return [];
  try {
    const drafts = await listDrafts(cwd, agent, roots, claudeConfigDir);
    return disambiguateTitles(drafts).map(toResumableEntry);
  } catch (error) {
    console.error("Failed to list resumable sessions", { agent, error });
    return [];
  }
}
