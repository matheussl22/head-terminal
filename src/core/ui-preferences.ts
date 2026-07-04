const SIDEBAR_COLLAPSED_KEY = "head-terminal.sidebar.collapsed";
const RUN_EVERYTHING_KEY = "head-terminal.run-everything";
const PANE_HEADERS_KEY = "head-terminal.pane-headers.enabled";
const OPENAI_API_KEY_KEY = "head-terminal.openai-api-key";

export function loadSidebarCollapsed(): boolean {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
}

// Cached: read on every TerminalPane render otherwise.
let paneHeadersCache: boolean | null = null;

export function loadPaneHeadersEnabled(): boolean {
  paneHeadersCache ??= localStorage.getItem(PANE_HEADERS_KEY) !== "0";
  return paneHeadersCache;
}

export function savePaneHeadersEnabled(enabled: boolean): void {
  paneHeadersCache = enabled;
  localStorage.setItem(PANE_HEADERS_KEY, enabled ? "1" : "0");
}

export function loadRunEverything(): boolean {
  return localStorage.getItem(RUN_EVERYTHING_KEY) === "1";
}

export function saveRunEverything(enabled: boolean): void {
  localStorage.setItem(RUN_EVERYTHING_KEY, enabled ? "1" : "0");
}

export function loadOpenAiApiKey(): string {
  return localStorage.getItem(OPENAI_API_KEY_KEY) ?? "";
}

export function saveOpenAiApiKey(apiKey: string): void {
  localStorage.setItem(OPENAI_API_KEY_KEY, apiKey.trim());
}
