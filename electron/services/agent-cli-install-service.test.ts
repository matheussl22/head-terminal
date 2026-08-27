import { afterEach, describe, expect, it } from "vitest";

import {
  configureAgentCliInstaller,
  ensureAgentClis,
} from "./agent-cli-install-service";

afterEach(() => {
  configureAgentCliInstaller({ wslMode: false });
  delete process.env.HEAD_TERMINAL_SKIP_CLI_INSTALL;
});

describe("ensureAgentClis", () => {
  it("installs only the missing official CLIs", async () => {
    const attempted: string[] = [];
    const result = await ensureAgentClis({
      skip: false,
      check: async () => ({
        antigravity: false,
        cursor: false,
        claude: true,
        codex: false,
        ollama: false,
        ornith: false,
      }),
      installers: {
        cursor: async () => {
          attempted.push("cursor");
        },
        claude: async () => {
          attempted.push("claude");
        },
        codex: async () => {
          attempted.push("codex");
        },
      },
    });

    expect(attempted).toEqual(["cursor", "codex"]);
    expect(result.installed).toEqual(["cursor", "codex"]);
    expect(result.failed).toEqual([]);
  });

  it("does not install anything that is already on PATH", async () => {
    const attempted: string[] = [];
    const result = await ensureAgentClis({
      skip: false,
      check: async () => ({
        antigravity: false,
        cursor: true,
        claude: true,
        codex: true,
        ollama: false,
        ornith: false,
      }),
      installers: {
        cursor: async () => {
          attempted.push("cursor");
        },
        claude: async () => {
          attempted.push("claude");
        },
        codex: async () => {
          attempted.push("codex");
        },
      },
    });

    expect(attempted).toEqual([]);
    expect(result.installed).toEqual([]);
  });

  it("keeps going when one installer fails", async () => {
    const result = await ensureAgentClis({
      skip: false,
      check: async () => ({
        antigravity: false,
        cursor: false,
        claude: false,
        codex: false,
        ollama: false,
        ornith: false,
      }),
      installers: {
        cursor: async () => {
          throw new Error("cursor down");
        },
        claude: async () => undefined,
        codex: async () => undefined,
      },
    });

    expect(result.installed).toEqual(["claude", "codex"]);
    expect(result.failed).toEqual([{ id: "cursor", error: "cursor down" }]);
  });

  it("skips network installs during smoke tests", async () => {
    const attempted: string[] = [];
    const result = await ensureAgentClis({
      skip: true,
      check: async () => ({
        antigravity: false,
        cursor: false,
        claude: false,
        codex: false,
        ollama: false,
        ornith: false,
      }),
      installers: {
        cursor: async () => {
          attempted.push("cursor");
        },
      },
    });

    expect(attempted).toEqual([]);
    expect(result.installed).toEqual([]);
    expect(result.status.cursor).toBe(false);
  });
});
