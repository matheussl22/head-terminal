import type { ITheme } from "@xterm/xterm";

import {
  DEFAULT_THEME_ID,
  getTheme,
  resolveThemeId,
  type AppTheme,
  type ThemePreference,
} from "../config/themes";
import { forEachTerminal } from "./terminal-registry";
import { loadThemePreference, saveThemePreference } from "./ui-preferences";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

let activeTheme: AppTheme = getTheme(DEFAULT_THEME_ID);
let systemQuery: MediaQueryList | null = null;

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia(DARK_SCHEME_QUERY).matches;
}

/** O tema pintado agora — o que os novos panes devem usar no xterm. */
export function getActiveTheme(): AppTheme {
  return activeTheme;
}

export function getActiveTerminalTheme(): ITheme {
  return { ...activeTheme.terminal };
}

function paintDocument(theme: AppTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme.kind;
  root.dataset.themeId = theme.id;
  for (const [token, value] of Object.entries(theme.app)) {
    root.style.setProperty(token, value);
  }
}

function repaintTerminals(theme: AppTheme): void {
  forEachTerminal((_paneId, handle) => {
    // xterm só repinta ao receber um objeto novo; mutar o antigo não dispara nada.
    handle.terminal.options.theme = { ...theme.terminal };
  });
}

function applyPreference(preference: ThemePreference): void {
  const theme = getTheme(resolveThemeId(preference, systemPrefersDark()));
  activeTheme = theme;
  paintDocument(theme);
  repaintTerminals(theme);
}

function onSystemSchemeChange(): void {
  if (loadThemePreference() === "system") {
    applyPreference("system");
  }
}

/**
 * Pinta o tema salvo e passa a seguir o modo do sistema quando a preferência
 * é "system". Chamar antes do primeiro render evita o flash do tema padrão.
 */
export function initTheme(): void {
  applyPreference(loadThemePreference());
  if (
    systemQuery === null &&
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
  ) {
    systemQuery = window.matchMedia(DARK_SCHEME_QUERY);
    systemQuery.addEventListener("change", onSystemSchemeChange);
  }
}

/** Salva e aplica na hora, em todos os panes abertos. */
export function setThemePreference(preference: ThemePreference): void {
  saveThemePreference(preference);
  applyPreference(preference);
}
