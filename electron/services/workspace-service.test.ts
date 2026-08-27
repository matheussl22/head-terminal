import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PersistedWorkspace } from "../types/api";
import { WorkspaceService } from "./workspace-service";

const cleanup: string[] = [];
const workspace = {
  version: 1,
  activeSessionId: "session-1",
  activePaneId: "pane-1",
  sessions: [{
    id: "session-1",
    title: "Claude",
    cwd: "/repo",
    agentProfileId: "claude",
    layout: { kind: "pane", paneId: "pane-1" },
  }],
} satisfies PersistedWorkspace;

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("workspace-service", () => {
  it("atomically saves and loads a versioned workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ht-workspace-"));
    cleanup.push(directory);
    const service = new WorkspaceService({ userDataPath: directory });
    await service.save(workspace);
    await expect(service.load()).resolves.toEqual(workspace);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("uses a separate dev workspace file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ht-workspace-"));
    cleanup.push(directory);
    const service = new WorkspaceService({ userDataPath: directory, channel: "dev" });
    await service.save(workspace);
    expect(await readFile(join(directory, "workspace.v1.dev.json"), "utf8")).toContain('"version": 1');
  });

  it("quarantines corrupted data and starts empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ht-workspace-"));
    cleanup.push(directory);
    const service = new WorkspaceService({
      userDataPath: directory,
      now: () => new Date("2026-07-19T12:00:00Z"),
    });
    await writeFile(service.workspacePath, "{broken");
    await expect(service.load()).resolves.toBeNull();
    expect(await readdir(directory)).toContain("workspace.v1.json.corrupt-2026-07-19T12-00-00-000Z");
  });

  it("keeps a bak after a successful save and recovers it when the main file is corrupt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ht-workspace-"));
    cleanup.push(directory);
    const service = new WorkspaceService({
      userDataPath: directory,
      now: () => new Date("2026-08-26T18:00:00Z"),
    });
    await service.save(workspace);
    expect(await readdir(directory)).toContain("workspace.v1.json.bak");
    expect(JSON.parse(await readFile(service.bakPath, "utf8"))).toEqual(workspace);

    await writeFile(service.workspacePath, "{broken");
    await expect(service.load()).resolves.toEqual(workspace);
    expect(await readdir(directory)).toContain("workspace.v1.json.corrupt-2026-08-26T18-00-00-000Z");
  });

  it("does not recover a bak that fails schema validation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ht-workspace-"));
    cleanup.push(directory);
    const service = new WorkspaceService({
      userDataPath: directory,
      now: () => new Date("2026-08-26T18:00:00Z"),
    });
    await service.save(workspace);
    await writeFile(service.workspacePath, "{broken");
    await writeFile(service.bakPath, JSON.stringify({ version: 2, sessions: [] }));
    await expect(service.load()).resolves.toBeNull();
  });

  it("round-trips conversation names and rejects malformed ones", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ht-workspace-"));
    cleanup.push(directory);
    const service = new WorkspaceService({ userDataPath: directory });
    const named = {
      ...workspace,
      conversationLabels: { "cli-session-1": "Faturamento" },
    } satisfies PersistedWorkspace;

    await service.save(named);
    await expect(service.load()).resolves.toEqual(named);

    await expect(
      service.save({
        ...workspace,
        conversationLabels: { "cli-session-1": 42 },
      } as unknown as PersistedWorkspace),
    ).rejects.toThrow("Workspace inválido");
  });

  it("rejects unsupported schemas before touching disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ht-workspace-"));
    cleanup.push(directory);
    const service = new WorkspaceService({ userDataPath: directory });
    await expect(service.save({ version: 2, sessions: [] } as unknown as PersistedWorkspace))
      .rejects.toThrow("Workspace inválido");
    expect(await readdir(directory)).toEqual([]);
  });
});
