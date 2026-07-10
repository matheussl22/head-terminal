import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createClaudeAccountProfile,
  DEFAULT_CLAUDE_ACCOUNT_ID,
  deleteClaudeAccountProfile,
  loadClaudeAccountProfiles,
  renameClaudeAccountProfile,
  resolveClaudeConfigDir,
} from "./claude-accounts";

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
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
    expect(resolveClaudeConfigDir(DEFAULT_CLAUDE_ACCOUNT_ID)).toBeUndefined();
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
  });

  it("deletes isolated profiles but preserves the global profile", () => {
    const company = createClaudeAccountProfile("Empresa", "/home/test");

    deleteClaudeAccountProfile(company.id);

    expect(loadClaudeAccountProfiles()).toHaveLength(1);
    expect(() => deleteClaudeAccountProfile(DEFAULT_CLAUDE_ACCOUNT_ID)).toThrow(
      "não pode ser excluída",
    );
  });
});
