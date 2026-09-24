import { describe, expect, it } from "vitest";

import {
  DEFAULT_THEME_ID,
  getTheme,
  isThemePreference,
  resolveThemeId,
  SYSTEM_DARK_THEME_ID,
  SYSTEM_LIGHT_THEME_ID,
  THEMES,
} from "./themes";

const COLOR = /^(#[0-9a-f]{6}|rgba?\([^)]*\)|0 \d+px \d+px rgba\([^)]*\))$/i;

describe("themes", () => {
  it("has unique ids and the default among them", () => {
    const ids = THEMES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_THEME_ID);
    expect(ids).toContain(SYSTEM_DARK_THEME_ID);
    expect(ids).toContain(SYSTEM_LIGHT_THEME_ID);
  });

  it("every theme overrides the same app tokens with well-formed colors", () => {
    const reference = Object.keys(getTheme(DEFAULT_THEME_ID).app).sort();
    for (const theme of THEMES) {
      expect(Object.keys(theme.app).sort()).toEqual(reference);
      for (const [token, value] of Object.entries(theme.app)) {
        expect(value, `${theme.id} ${token}`).toMatch(COLOR);
      }
      for (const [key, value] of Object.entries(theme.terminal)) {
        expect(value, `${theme.id} terminal.${key}`).toMatch(COLOR);
      }
    }
  });

  it("terminal background matches the app's darkest surface", () => {
    for (const theme of THEMES) {
      expect(theme.terminal.background).toBe(theme.app["--bg-0"]);
    }
  });

  it("resolves the system preference by color scheme", () => {
    expect(resolveThemeId("system", true)).toBe(SYSTEM_DARK_THEME_ID);
    expect(resolveThemeId("system", false)).toBe(SYSTEM_LIGHT_THEME_ID);
    expect(resolveThemeId("nord", false)).toBe("nord");
    expect(getTheme(SYSTEM_LIGHT_THEME_ID).kind).toBe("light");
  });

  it("rejects unknown preferences", () => {
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("dracula")).toBe(true);
    expect(isThemePreference("neon")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });
});
