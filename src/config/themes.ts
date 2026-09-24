import type { ITheme } from "@xterm/xterm";

/**
 * Um tema pinta duas coisas: o chrome do app (tokens CSS em `:root`) e o
 * xterm de cada pane. Os dois vivem juntos aqui para que a barra lateral e o
 * terminal nunca discordem sobre o que é "fundo" e o que é "destaque".
 *
 * Só os tokens que mudam de tema para tema aparecem em `app`; espaçamento,
 * raios e as cores de status semânticas ficam em tokens.css e valem para todos.
 */
export type ThemeId =
  | "graphite"
  | "light"
  | "nord"
  | "dracula"
  | "solarized-dark";

/** O que fica salvo: um tema fixo, ou seguir o modo claro/escuro do sistema. */
export type ThemePreference = ThemeId | "system";

export type ThemeAppTokens = Record<
  | "--bg-0"
  | "--bg-1"
  | "--bg-2"
  | "--bg-3"
  | "--bg-4"
  | "--surface-input"
  | "--surface-overlay"
  | "--surface-hover"
  | "--border-subtle"
  | "--border-default"
  | "--border-strong"
  | "--text-primary"
  | "--text-secondary"
  | "--text-muted"
  | "--accent"
  | "--accent-hover"
  | "--accent-fg"
  | "--accent-subtle"
  | "--accent-muted"
  | "--shadow-menu"
  | "--shadow-dialog",
  string
>;

export interface AppTheme {
  id: ThemeId;
  name: string;
  /** Define `color-scheme` e os controles nativos (scrollbars, inputs). */
  kind: "dark" | "light";
  app: ThemeAppTokens;
  terminal: Required<
    Pick<
      ITheme,
      | "background"
      | "foreground"
      | "cursor"
      | "cursorAccent"
      | "selectionBackground"
      | "black"
      | "red"
      | "green"
      | "yellow"
      | "blue"
      | "magenta"
      | "cyan"
      | "white"
      | "brightBlack"
      | "brightRed"
      | "brightGreen"
      | "brightYellow"
      | "brightBlue"
      | "brightMagenta"
      | "brightCyan"
      | "brightWhite"
    >
  >;
}

// Grafite: quase-preto, texto branco suave, cursor âmbar. As cores ANSI foram
// ajustadas para ler bem em #0b0c0e sem virar neon — o chrome em volta é
// deliberadamente quieto, e as cores do terminal é que carregam a informação.
const GRAPHITE: AppTheme = {
  id: "graphite",
  name: "Grafite",
  kind: "dark",
  app: {
    "--bg-0": "#0b0c0e",
    "--bg-1": "#111316",
    "--bg-2": "#15171b",
    "--bg-3": "#1b1e23",
    "--bg-4": "#22262c",
    "--surface-input": "#0e1013",
    "--surface-overlay": "rgba(11, 12, 14, 0.82)",
    "--surface-hover": "rgba(255, 255, 255, 0.03)",
    "--border-subtle": "#23262c",
    "--border-default": "#2a2d33",
    "--border-strong": "#3a3e46",
    "--text-primary": "#e6e7ea",
    "--text-secondary": "#a9adb5",
    "--text-muted": "#757a83",
    "--accent": "#f0a832",
    "--accent-hover": "#f7b94f",
    "--accent-fg": "#1a1200",
    "--accent-subtle": "rgba(240, 168, 50, 0.12)",
    "--accent-muted": "rgba(240, 168, 50, 0.45)",
    "--shadow-menu": "0 8px 24px rgba(0, 0, 0, 0.45)",
    "--shadow-dialog": "0 24px 64px rgba(0, 0, 0, 0.6)",
  },
  terminal: {
    background: "#0b0c0e",
    foreground: "#e6e7ea",
    cursor: "rgba(240, 168, 50, 0.9)",
    cursorAccent: "#0b0c0e",
    selectionBackground: "rgba(240, 168, 50, 0.28)",
    black: "#1b1e23",
    red: "#ff6b6b",
    green: "#56d364",
    yellow: "#e3b341",
    blue: "#58a6ff",
    magenta: "#d98cd6",
    cyan: "#56d4dd",
    white: "#d6d9de",
    brightBlack: "#7d838c",
    brightRed: "#ff8e8a",
    brightGreen: "#7ee787",
    brightYellow: "#f2cc60",
    brightBlue: "#79c0ff",
    brightMagenta: "#e8a9e5",
    brightCyan: "#8ae6ee",
    brightWhite: "#ffffff",
  },
};

// Claro: papel frio, tinta grafite, âmbar mais escuro para manter contraste
// sobre o branco. ANSI na linha do GitHub Light, que já foi calibrado para
// fundo branco.
const LIGHT: AppTheme = {
  id: "light",
  name: "Claro",
  kind: "light",
  app: {
    "--bg-0": "#ffffff",
    "--bg-1": "#f6f7f9",
    "--bg-2": "#eef0f3",
    "--bg-3": "#e6e8ec",
    "--bg-4": "#dcdfe5",
    "--surface-input": "#ffffff",
    "--surface-overlay": "rgba(246, 247, 249, 0.86)",
    "--surface-hover": "rgba(0, 0, 0, 0.04)",
    "--border-subtle": "#e3e6eb",
    "--border-default": "#d3d7de",
    "--border-strong": "#b7bcc6",
    "--text-primary": "#1f2328",
    "--text-secondary": "#4b5159",
    "--text-muted": "#767d87",
    "--accent": "#c47a12",
    "--accent-hover": "#a96608",
    "--accent-fg": "#ffffff",
    "--accent-subtle": "rgba(196, 122, 18, 0.12)",
    "--accent-muted": "rgba(196, 122, 18, 0.4)",
    "--shadow-menu": "0 8px 24px rgba(31, 35, 40, 0.16)",
    "--shadow-dialog": "0 24px 64px rgba(31, 35, 40, 0.24)",
  },
  terminal: {
    background: "#ffffff",
    foreground: "#1f2328",
    cursor: "rgba(196, 122, 18, 0.95)",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(196, 122, 18, 0.25)",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#7d4e00",
    brightBlue: "#0550ae",
    brightMagenta: "#6639ba",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
};

// Nord: azul-ardósia com o "frost" como destaque.
const NORD: AppTheme = {
  id: "nord",
  name: "Nord",
  kind: "dark",
  app: {
    "--bg-0": "#2e3440",
    "--bg-1": "#323846",
    "--bg-2": "#373e4c",
    "--bg-3": "#3b4252",
    "--bg-4": "#434c5e",
    "--surface-input": "#2b303b",
    "--surface-overlay": "rgba(46, 52, 64, 0.84)",
    "--surface-hover": "rgba(236, 239, 244, 0.04)",
    "--border-subtle": "#3b4252",
    "--border-default": "#434c5e",
    "--border-strong": "#4c566a",
    "--text-primary": "#eceff4",
    "--text-secondary": "#d8dee9",
    "--text-muted": "#8f9ab1",
    "--accent": "#88c0d0",
    "--accent-hover": "#9fd0de",
    "--accent-fg": "#1c2330",
    "--accent-subtle": "rgba(136, 192, 208, 0.14)",
    "--accent-muted": "rgba(136, 192, 208, 0.45)",
    "--shadow-menu": "0 8px 24px rgba(0, 0, 0, 0.4)",
    "--shadow-dialog": "0 24px 64px rgba(0, 0, 0, 0.55)",
  },
  terminal: {
    background: "#2e3440",
    foreground: "#d8dee9",
    cursor: "rgba(136, 192, 208, 0.9)",
    cursorAccent: "#2e3440",
    selectionBackground: "rgba(136, 192, 208, 0.3)",
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
};

// Dracula: roxo-escuro com o rosa como destaque.
const DRACULA: AppTheme = {
  id: "dracula",
  name: "Dracula",
  kind: "dark",
  app: {
    "--bg-0": "#282a36",
    "--bg-1": "#2c2e3b",
    "--bg-2": "#313342",
    "--bg-3": "#383a4a",
    "--bg-4": "#44475a",
    "--surface-input": "#22232d",
    "--surface-overlay": "rgba(40, 42, 54, 0.84)",
    "--surface-hover": "rgba(248, 248, 242, 0.04)",
    "--border-subtle": "#353747",
    "--border-default": "#44475a",
    "--border-strong": "#5a5e78",
    "--text-primary": "#f8f8f2",
    "--text-secondary": "#c9cbd6",
    "--text-muted": "#8a8ea3",
    "--accent": "#ff79c6",
    "--accent-hover": "#ff96d2",
    "--accent-fg": "#2a1020",
    "--accent-subtle": "rgba(255, 121, 198, 0.14)",
    "--accent-muted": "rgba(255, 121, 198, 0.45)",
    "--shadow-menu": "0 8px 24px rgba(0, 0, 0, 0.45)",
    "--shadow-dialog": "0 24px 64px rgba(0, 0, 0, 0.6)",
  },
  terminal: {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "rgba(255, 121, 198, 0.9)",
    cursorAccent: "#282a36",
    selectionBackground: "rgba(68, 71, 90, 0.9)",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
};

// Solarized Dark: as cores canônicas de Ethan Schoonover, com o laranja como
// destaque para não competir com o azul-ciano do texto.
const SOLARIZED_DARK: AppTheme = {
  id: "solarized-dark",
  name: "Solarized Dark",
  kind: "dark",
  app: {
    "--bg-0": "#002b36",
    "--bg-1": "#03303c",
    "--bg-2": "#073642",
    "--bg-3": "#0b3d4a",
    "--bg-4": "#134652",
    "--surface-input": "#00252f",
    "--surface-overlay": "rgba(0, 43, 54, 0.84)",
    "--surface-hover": "rgba(238, 232, 213, 0.04)",
    "--border-subtle": "#073642",
    "--border-default": "#0f4552",
    "--border-strong": "#1f5866",
    "--text-primary": "#eee8d5",
    "--text-secondary": "#93a1a1",
    "--text-muted": "#657b83",
    "--accent": "#cb4b16",
    "--accent-hover": "#e05a22",
    "--accent-fg": "#fdf6e3",
    "--accent-subtle": "rgba(203, 75, 22, 0.14)",
    "--accent-muted": "rgba(203, 75, 22, 0.45)",
    "--shadow-menu": "0 8px 24px rgba(0, 0, 0, 0.45)",
    "--shadow-dialog": "0 24px 64px rgba(0, 0, 0, 0.6)",
  },
  terminal: {
    background: "#002b36",
    foreground: "#839496",
    cursor: "rgba(203, 75, 22, 0.9)",
    cursorAccent: "#002b36",
    selectionBackground: "rgba(7, 54, 66, 0.95)",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#586e75",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
};

export const THEMES: readonly AppTheme[] = [
  GRAPHITE,
  LIGHT,
  NORD,
  DRACULA,
  SOLARIZED_DARK,
];

export const DEFAULT_THEME_ID: ThemeId = "graphite";

/** Tema usado quando a preferência é "system" e o SO está em cada modo. */
export const SYSTEM_DARK_THEME_ID: ThemeId = "graphite";
export const SYSTEM_LIGHT_THEME_ID: ThemeId = "light";

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || isThemeId(value);
}

export function getTheme(id: ThemeId): AppTheme {
  return THEMES.find((theme) => theme.id === id) ?? GRAPHITE;
}

/** Decide qual tema pintar a partir da preferência e do modo do sistema. */
export function resolveThemeId(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ThemeId {
  if (preference !== "system") {
    return preference;
  }
  return systemPrefersDark ? SYSTEM_DARK_THEME_ID : SYSTEM_LIGHT_THEME_ID;
}
