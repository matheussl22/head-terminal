const SIDEBAR_COLLAPSED_KEY = "head-terminal.sidebar.collapsed";
const RUN_EVERYTHING_KEY = "head-terminal.run-everything";
const PANE_HEADERS_KEY = "head-terminal.pane-headers.enabled";

export function loadSidebarCollapsed(): boolean {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
}

export function loadPaneHeadersEnabled(): boolean {
  return localStorage.getItem(PANE_HEADERS_KEY) !== "0";
}

export function savePaneHeadersEnabled(enabled: boolean): void {
  localStorage.setItem(PANE_HEADERS_KEY, enabled ? "1" : "0");
}

export function loadRunEverything(): boolean {
  return localStorage.getItem(RUN_EVERYTHING_KEY) === "1";
}

export function saveRunEverything(enabled: boolean): void {
  localStorage.setItem(RUN_EVERYTHING_KEY, enabled ? "1" : "0");
}
