import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkAgentClis,
  deleteClaudeProfileDir,
  getDefaultCwd,
  pathExists,
  setPosixHome,
} from "./system-service";

const cleanup: string[] = [];

afterEach(async () => {
  setPosixHome(null);
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("system-service", () => {
  it("keeps the default Documentos cwd when it exists", async () => {
    // On Windows the panes live in the distro, so once its $HOME is installed
    // the default cwd is POSIX no matter what the host's home looks like.
    const home = await mkdtemp(join(tmpdir(), "ht-home-"));
    cleanup.push(home);
    await mkdir(join(home, "Documentos"));

    setPosixHome(home);
    await expect(getDefaultCwd()).resolves.toBe(`${home}/Documentos`);
  });

  it("falls back to the home when Documentos is not there", async () => {
    // The folder only exists on a machine set up in Portuguese, and a pane
    // whose cwd does not exist cannot start at all.
    const home = await mkdtemp(join(tmpdir(), "ht-home-"));
    cleanup.push(home);

    setPosixHome(home);
    await expect(getDefaultCwd()).resolves.toBe(home);
  });

  it("distinguishes directories from files and invalid paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ht-system-"));
    cleanup.push(directory);
    const file = join(directory, "file.txt");
    await writeFile(file, "content");

    await expect(pathExists(directory)).resolves.toBe(true);
    await expect(pathExists(file)).resolves.toBe(false);
    await expect(pathExists("bad\0path")).resolves.toBe(false);
  });

  it("rejects profile deletion outside the managed UUID directory", async () => {
    await expect(
      deleteClaudeProfileDir(
        "/tmp/123e4567-e89b-12d3-a456-426614174000",
      ),
    ).rejects.toThrow("Caminho de perfil inválido");
    await expect(deleteClaudeProfileDir("/tmp"))
      .rejects.toThrow("Caminho de perfil inválido");
  });

  it("returns a complete boolean CLI status", async () => {
    const status = await checkAgentClis();
    expect(status).toEqual({
      antigravity: expect.any(Boolean),
      cursor: expect.any(Boolean),
      claude: expect.any(Boolean),
      codex: expect.any(Boolean),
    });
  });
});
