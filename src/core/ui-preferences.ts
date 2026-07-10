const SIDEBAR_COLLAPSED_KEY = "head-terminal.sidebar.collapsed";
const RUN_EVERYTHING_KEY = "head-terminal.run-everything";
const PANE_HEADERS_KEY = "head-terminal.pane-headers.enabled";
const OPENAI_API_KEY_KEY = "head-terminal.openai-api-key";
const FONT_SIZE_KEY = "head-terminal.font-size";
const RENDERER_KEY = "head-terminal.renderer";
const COPY_ON_SELECT_KEY = "head-terminal.copy-on-select";
const RECENT_CWDS_KEY = "head-terminal.recent-cwds";
const LAST_AGENT_KEY = "head-terminal.last-agent";
const LAST_CLAUDE_ACCOUNT_KEY = "head-terminal.last-claude-account";

export type TerminalRenderer = "auto" | "webgl" | "dom";

// localStorage is absent in node test runs; treat it as empty there.
function storageGet(key: string): string | null {
  return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
}

function storageSet(key: string, value: string): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(key, value);
  }
}

export function loadSidebarCollapsed(): boolean {
  return storageGet(SIDEBAR_COLLAPSED_KEY) === "1";
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  storageSet(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
}

// Cached: read on every TerminalPane render otherwise.
let paneHeadersCache: boolean | null = null;

export function loadPaneHeadersEnabled(): boolean {
  paneHeadersCache ??= storageGet(PANE_HEADERS_KEY) !== "0";
  return paneHeadersCache;
}

export function savePaneHeadersEnabled(enabled: boolean): void {
  paneHeadersCache = enabled;
  storageSet(PANE_HEADERS_KEY, enabled ? "1" : "0");
}

export function loadRunEverything(): boolean {
  return storageGet(RUN_EVERYTHING_KEY) === "1";
}

export function saveRunEverything(enabled: boolean): void {
  storageSet(RUN_EVERYTHING_KEY, enabled ? "1" : "0");
}

export function loadOpenAiApiKey(): string {
  return storageGet(OPENAI_API_KEY_KEY) ?? "";
}

export function saveOpenAiApiKey(apiKey: string): void {
  storageSet(OPENAI_API_KEY_KEY, apiKey.trim());
}

const FONT_MIN = 8;
const FONT_MAX = 24;

let fontSizeCache: number | null = null;

export function loadFontSize(): number {
  if (fontSizeCache !== null) {
    return fontSizeCache;
  }
  const raw = storageGet(FONT_SIZE_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  fontSizeCache = Number.isFinite(parsed)
    ? Math.min(FONT_MAX, Math.max(FONT_MIN, parsed))
    : 12;
  return fontSizeCache;
}

export function saveFontSize(size: number): void {
  fontSizeCache = Math.min(FONT_MAX, Math.max(FONT_MIN, size));
  storageSet(FONT_SIZE_KEY, String(fontSizeCache));
}

export function loadRendererPreference(): TerminalRenderer {
  const raw = storageGet(RENDERER_KEY);
  return raw === "webgl" || raw === "dom" ? raw : "auto";
}

export function saveRendererPreference(renderer: TerminalRenderer): void {
  storageSet(RENDERER_KEY, renderer);
}

let copyOnSelectCache: boolean | null = null;

export function loadCopyOnSelect(): boolean {
  copyOnSelectCache ??= storageGet(COPY_ON_SELECT_KEY) === "1";
  return copyOnSelectCache;
}

export function saveCopyOnSelect(enabled: boolean): void {
  copyOnSelectCache = enabled;
  storageSet(COPY_ON_SELECT_KEY, enabled ? "1" : "0");
}

export function loadRecentCwds(): string[] {
  try {
    const raw = storageGet(RECENT_CWDS_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

export function noteRecentCwd(cwd: string): void {
  const trimmed = cwd.trim();
  if (!trimmed) {
    return;
  }
  const next = [trimmed, ...loadRecentCwds().filter((item) => item !== trimmed)].slice(
    0,
    8,
  );
  storageSet(RECENT_CWDS_KEY, JSON.stringify(next));
}

export function loadLastAgent(): string {
  return storageGet(LAST_AGENT_KEY) ?? "cursor";
}

export function saveLastAgent(agentId: string): void {
  storageSet(LAST_AGENT_KEY, agentId);
}

export function loadLastClaudeAccount(): string {
  return storageGet(LAST_CLAUDE_ACCOUNT_KEY) ?? "default";
}

export function saveLastClaudeAccount(accountId: string): void {
  storageSet(LAST_CLAUDE_ACCOUNT_KEY, accountId);
}
