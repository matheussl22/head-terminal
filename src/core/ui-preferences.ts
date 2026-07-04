const SIDEBAR_COLLAPSED_KEY = "head-terminal.sidebar.collapsed";
const RUN_EVERYTHING_KEY = "head-terminal.run-everything";
const PANE_HEADERS_KEY = "head-terminal.pane-headers.enabled";
const OPENAI_API_KEY_KEY = "head-terminal.openai-api-key";

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
