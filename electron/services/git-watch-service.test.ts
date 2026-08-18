import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitWatchService,
  type GitContextChangedEvent,
} from "./git-watch-service";

const cleanup: string[] = [];
const services: GitWatchService[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ht-watch-"));
  cleanup.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  git(repo, "init", "-q");
  git(
    repo,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "initial",
  );
  // The path as git spells it, which is the key the watcher stores repos
  // under: forward slashes on Windows, symlinks resolved.
  return git(repo, "rev-parse", "--show-toplevel");
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.dispose();
  }
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("GitWatchService", () => {
  it("shares a repo watcher and releases it at zero subscribers", async () => {
    const repo = await createRepo();
    const service = new GitWatchService();
    services.push(service);

    await service.watch({ watchId: "session:1", cwd: repo });
    await service.watch({ watchId: "session:2", cwd: repo });
    expect(service.watchedRepoCount).toBe(1);
    expect(service.subscriberCount(repo)).toBe(2);

    await service.unwatch("session:1");
    expect(service.watchedRepoCount).toBe(1);
    await service.unwatch("session:2");
    expect(service.watchedRepoCount).toBe(0);
  });

  it("debounces git filesystem changes and fans out fresh context", async () => {
    const repo = await createRepo();
    const service = new GitWatchService();
    services.push(service);
    const listener = vi.fn<(event: GitContextChangedEvent) => void>();
    service.onChanged(listener);

    await service.watch({ watchId: "pane:1", cwd: repo });
    await service.watch({ watchId: "pane:2", cwd: repo });
    listener.mockClear();

    await writeFile(join(repo, "new.txt"), "new");
    git(repo, "add", "new.txt");

    await vi.waitFor(
      () => {
        const dirtyEvents = listener.mock.calls
          .map(([event]) => event)
          .filter((event) => event.context.isDirty);
        expect(new Set(dirtyEvents.map((event) => event.watchId))).toEqual(
          new Set(["pane:1", "pane:2"]),
        );
      },
      { timeout: 3_000 },
    );
  });

  it("detaches a reused watch id from its previous repository", async () => {
    const firstRepo = await createRepo();
    const secondRepo = await createRepo();
    const service = new GitWatchService();
    services.push(service);

    await service.watch({ watchId: "pane:move", cwd: firstRepo });
    await service.watch({ watchId: "pane:move", cwd: secondRepo });
    expect(service.subscriberCount(firstRepo)).toBe(0);
    expect(service.subscriberCount(secondRepo)).toBe(1);
    expect(service.watchedRepoCount).toBe(1);
  });

  it("polls instead of watching, and only speaks when the context changed", async () => {
    const repo = await createRepo();
    const service = new GitWatchService({ pollIntervalMs: 50 });
    services.push(service);
    const listener = vi.fn<(event: GitContextChangedEvent) => void>();
    service.onChanged(listener);

    await service.watch({ watchId: "pane:1", cwd: repo });
    listener.mockClear();

    // A quiet repository must not produce one event per tick.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(listener).not.toHaveBeenCalled();

    await writeFile(join(repo, "new.txt"), "new");
    git(repo, "add", "new.txt");

    await vi.waitFor(
      () => {
        expect(listener.mock.calls.at(-1)?.[0].context.isDirty).toBe(true);
      },
      { timeout: 3_000 },
    );
  });

  it("rejects unsafe or unbounded watch identifiers", async () => {
    const service = new GitWatchService();
    services.push(service);
    await expect(
      service.watch({ watchId: "../bad", cwd: "/tmp" }),
    ).rejects.toThrow("Identificador de watcher inválido");
    await expect(service.unwatch("x".repeat(129))).rejects.toThrow(
      "Identificador de watcher inválido",
    );
  });
});
