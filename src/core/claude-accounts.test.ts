import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  claudeProfileConfigDir,
  createClaudeAccountProfile,
  DEFAULT_CLAUDE_ACCOUNT_ID,
  deleteClaudeAccountProfile,
  loadClaudeAccountProfiles,
  renameClaudeAccountProfile,
  resolveClaudeConfigDir,
} from "./claude-accounts";
import { setCachedPlatformInfoForTests } from "./platform-info";

const values = new Map<string, string>();

function platform(homeDir: string) {
  return {
    platform: "linux",
    homeDir,
  } as unknown as Parameters<typeof setCachedPlatformInfoForTests>[0];
}

beforeEach(() => {
  values.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  setCachedPlatformInfoForTests(platform("/home/test"));
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
  setCachedPlatformInfoForTests(null);
});

describe("claude account profiles", () => {
  it("persists an isolated profile and resolves its config directory", () => {
    const profile = createClaudeAccountProfile("Empresa", "/home/test/");

    expect(loadClaudeAccountProfiles().map(({ id }) => id)).toEqual([
      DEFAULT_CLAUDE_ACCOUNT_ID,
      profile.id,
    ]);
    expect(resolveClaudeConfigDir(profile.id)).toBe(
      `/home/test/.head-terminal/claude-profiles/${profile.id}`,
    );
  });

  it("keeps the default profile out of the user's global ~/.claude", () => {
    // A pane on ~/.claude would share login and history with every terminal
    // opened outside the app; the default profile is isolated like the rest.
    expect(resolveClaudeConfigDir(DEFAULT_CLAUDE_ACCOUNT_ID)).toBe(
      "/home/test/.head-terminal/claude-profiles/default",
    );
    expect(resolveClaudeConfigDir(undefined)).toBe(
      "/home/test/.head-terminal/claude-profiles/default",
    );
    expect(loadClaudeAccountProfiles()[0].configDir).toBe(
      "/home/test/.head-terminal/claude-profiles/default",
    );
  });

  it("spells the profile dir with the home's own separator", () => {
    expect(claudeProfileConfigDir("C:\\Users\\me", "default")).toBe(
      "C:\\Users\\me\\.head-terminal\\claude-profiles\\default",
    );
    setCachedPlatformInfoForTests(platform("C:\\Users\\me\\"));
    expect(resolveClaudeConfigDir()).toBe(
      "C:\\Users\\me\\.head-terminal\\claude-profiles\\default",
    );
  });

  it("refuses to resolve a directory while the home is unknown instead of falling back", () => {
    setCachedPlatformInfoForTests(null);
    expect(loadClaudeAccountProfiles()[0].configDir).toBeUndefined();
    expect(() => resolveClaudeConfigDir(DEFAULT_CLAUDE_ACCOUNT_ID)).toThrow(
      "indisponível",
    );
  });

  it("rejects duplicate names and missing profiles", () => {
    createClaudeAccountProfile("Pessoal", "/home/test");

    expect(() => createClaudeAccountProfile(" pessoal ", "/home/test")).toThrow(
      "Já existe",
    );
    expect(() => resolveClaudeConfigDir("removed")).toThrow("não encontrado");
  });

  it("renames the default and isolated profiles without changing their binding", () => {
    const company = createClaudeAccountProfile("Empresa", "/home/test");

    renameClaudeAccountProfile(DEFAULT_CLAUDE_ACCOUNT_ID, "Pessoal");
    renameClaudeAccountProfile(company.id, "Trabalho");

    expect(loadClaudeAccountProfiles().map(({ name }) => name)).toEqual([
      "Pessoal",
      "Trabalho",
    ]);
    expect(resolveClaudeConfigDir(company.id)).toContain(company.id);
    expect(resolveClaudeConfigDir(DEFAULT_CLAUDE_ACCOUNT_ID)).toContain("/default");
  });

  it("deletes isolated profiles but preserves the default profile", () => {
    const company = createClaudeAccountProfile("Empresa", "/home/test");

    deleteClaudeAccountProfile(company.id);

    expect(loadClaudeAccountProfiles()).toHaveLength(1);
    expect(() => deleteClaudeAccountProfile(DEFAULT_CLAUDE_ACCOUNT_ID)).toThrow(
      "não pode ser excluída",
    );
  });
});
