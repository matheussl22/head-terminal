import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PersistedWorkspace } from "../types/api";
import {
  decodeWebKitStorageValue,
  MigrationService,
} from "./migration-service";
import { WorkspaceService } from "./workspace-service";

const cleanup: string[] = [];
const workspace = {
  version: 1,
  activeSessionId: null,
  activePaneId: null,
  sessions: [],
} satisfies PersistedWorkspace;

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ht-migration-"));
  cleanup.push(directory);
  const sourcePath = join(directory, "tauri", "migration-v1.json");
  const userDataPath = join(directory, "electron");
  const workspaceService = new WorkspaceService({ userDataPath });
  return {
    directory,
    sourcePath,
    userDataPath,
    workspaceService,
    service: new MigrationService({
      userDataPath,
      sourcePath,
      workspaceService,
      legacyDatabasePaths: [],
    }),
  };
}

describe("migration-service", () => {
  it("imports Tauri localStorage export without deleting or changing its source", async () => {
    const { sourcePath, workspaceService, service } = await fixture();
    const payload = JSON.stringify({
      version: 1,
      localStorage: {
        "head-terminal.workspace.v1": JSON.stringify(workspace),
        "head-terminal.sidebar.collapsed": "1",
        "head-terminal.claude-accounts": JSON.stringify([{ id: "account" }]),
        "head-terminal.openai-api-key": "must-not-be-imported",
      },
    });
    await mkdir(join(sourcePath, ".."), { recursive: true });
    await writeFile(sourcePath, payload);

    const result = await service.importIfAvailable();
    expect(result).toMatchObject({ status: "imported", workspaceImported: true, preferenceCount: 2 });
    await expect(workspaceService.load()).resolves.toEqual(workspace);
    expect(await readFile(sourcePath, "utf8")).toBe(payload);
    expect(result.preferences).not.toHaveProperty("head-terminal.openai-api-key");
  });

  it("is idempotent and preserves an existing Electron workspace", async () => {
    const { workspaceService, service } = await fixture();
    await workspaceService.save(workspace);
    const payload = {
      version: 1,
      workspace: { ...workspace, activeSessionId: "legacy" },
      preferences: { "head-terminal.font-size": "14" },
    };
    await expect(service.importPayload(payload)).resolves.toMatchObject({
      status: "imported", workspaceImported: false,
    });
    await expect(service.importPayload(payload)).resolves.toMatchObject({
      status: "already-completed", workspaceImported: false,
    });
    await expect(workspaceService.load()).resolves.toEqual(workspace);
  });

  it("does not create a completion marker for missing or corrupt input", async () => {
    const { sourcePath, service } = await fixture();
    await expect(service.importIfAvailable()).resolves.toMatchObject({ status: "not-found" });
    await mkdir(join(sourcePath, ".."), { recursive: true });
    await writeFile(sourcePath, "not json");
    await expect(service.importIfAvailable()).resolves.toMatchObject({ status: "invalid" });
    await expect(readFile(service.markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("decodes WebKit UTF-16LE values and imports a DB snapshot read-only", async () => {
    const { sourcePath, userDataPath, workspaceService } = await fixture();
    const databasePath = join(sourcePath, "..", "tauri_localhost_0.localstorage");
    const encodedWorkspace = Buffer.from(JSON.stringify(workspace), "utf16le");
    expect(decodeWebKitStorageValue(encodedWorkspace)).toBe(JSON.stringify(workspace));
    expect(decodeWebKitStorageValue(Buffer.from("\ufeffvalor\0", "utf16le"))).toBe("valor");

    const reader = async (path: string) => path === databasePath ? {
      "head-terminal.workspace.v1": decodeWebKitStorageValue(encodedWorkspace),
      "head-terminal.font-size": "15",
      "head-terminal.openai-api-key": "excluded",
    } : null;
    const service = new MigrationService({
      userDataPath,
      sourcePath,
      workspaceService,
      legacyDatabasePaths: [databasePath],
      readLegacyDatabase: reader,
    });

    await expect(service.importIfAvailable()).resolves.toMatchObject({
      status: "imported",
      source: databasePath,
      workspaceImported: true,
      preferenceCount: 1,
      preferences: { "head-terminal.font-size": "15" },
    });
    // Reader receives a path only; production opens it with readOnly: true and
    // migration never writes, renames, or removes the source database.
    await expect(workspaceService.load()).resolves.toEqual(workspace);
  });
});
