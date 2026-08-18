import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSessionWorktree,
  getGitContext,
  getSessionDiff,
} from "./git-service";

const cleanup: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  }).trim();
}

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ht-git-"));
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
  // The path as git spells it, which is what the service keys and returns:
  // forward slashes on Windows, and the resolved target of any symlink.
  return git(repo, "rev-parse", "--show-toplevel");
}

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("git-service", () => {
  it("returns the empty payload outside a repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ht-no-git-"));
    cleanup.push(directory);
    await expect(getGitContext(directory)).resolves.toEqual({
      repoRoot: null,
      branch: null,
      headShort: null,
      headRef: "",
      isDirty: false,
    });
  });

  it("resolves clean, dirty and detached HEAD contexts", async () => {
    const repo = await createRepo();
    const clean = await getGitContext(repo);
    expect(clean.repoRoot).toBe(repo);
    expect(clean.branch).toBeTruthy();
    expect(clean.headShort).toMatch(/^[0-9a-f]+$/u);
    expect(clean.isDirty).toBe(false);

    await writeFile(join(repo, "untracked.txt"), "new");
    expect((await getGitContext(repo)).isDirty).toBe(true);

    git(repo, "checkout", "--detach", "-q");
    const detached = await getGitContext(repo);
    expect(detached.branch).toBeNull();
    expect(detached.headRef).toBe(detached.headShort);
  });

  it("combines tracked diff and untracked annotations", async () => {
    const repo = await createRepo();
    await writeFile(join(repo, "tracked.txt"), "before\n");
    git(repo, "add", "tracked.txt");
    git(
      repo,
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-q",
      "-m",
      "tracked",
    );
    await writeFile(join(repo, "tracked.txt"), "after\n");
    await writeFile(join(repo, "new.txt"), "new\n");

    const diff = await getSessionDiff(repo);
    expect(diff).toContain("-before");
    expect(diff).toContain("+after");
    expect(diff).toContain("?? novo arquivo (untracked): new.txt");
  });

  it("creates collision-free numbered sibling worktrees", async () => {
    const repo = await createRepo();
    const first = await createSessionWorktree(repo);
    const second = await createSessionWorktree(repo);
    expect(first).toBe(`${repo}-agent-1`);
    expect(second).toBe(`${repo}-agent-2`);
    expect(git(first, "branch", "--show-current")).toBe("agent-1");
    expect(git(second, "branch", "--show-current")).toBe("agent-2");
  });

  it("does not interpret a cwd as shell syntax", async () => {
    const root = await mkdtemp(join(tmpdir(), "ht-git-safe-"));
    cleanup.push(root);
    const marker = join(root, "injected");
    const malicious = `${root};touch ${marker}`;
    const context = await getGitContext(malicious);
    expect(context.repoRoot).toBeNull();
    await expect(import("node:fs/promises").then(({ stat }) => stat(marker)))
      .rejects.toThrow();
  });
});
