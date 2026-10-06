import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  directCommandRunner,
  resetCommandRunner,
  resolveCommand,
  runCommand,
  setCommandRunner,
  type CommandFailure,
} from "./command-runner";

afterEach(() => resetCommandRunner());

/**
 * The child is always `node` itself: these tests exercise the runner, not a
 * shell, and the suite has to run on Windows too — where `/bin/sh` and
 * `/bin/echo` do not exist.
 */
const NODE = process.execPath;
const echo = (text: string) => ["-e", `process.stdout.write(${JSON.stringify(text)})`];

describe("command-runner", () => {
  it("resolves with the child output", async () => {
    expect(await directCommandRunner(NODE, echo("hi\n")))
      .toEqual({ stdout: "hi\n", stderr: "" });
  });

  it("keeps stderr on the rejection so callers can report it", async () => {
    const failure = await directCommandRunner(NODE, [
      "-e",
      "process.stderr.write('boom\\n'); process.exit(3)",
    ]).catch((error: CommandFailure) => error);

    expect((failure as CommandFailure).stderr).toBe("boom\n");
  });

  it("routes every caller through the runner installed at startup", async () => {
    const installed = vi.fn(async () => ({ stdout: "stub", stderr: "" }));
    setCommandRunner(installed);

    expect(await runCommand("git", ["status"])).toEqual({ stdout: "stub", stderr: "" });
    expect(installed).toHaveBeenCalledWith("git", ["status"], undefined);
  });
});

describe.skipIf(process.platform === "win32")("command resolution", () => {
  const previousPath = process.env.PATH;
  const cleanup: string[] = [];

  afterEach(async () => {
    process.env.PATH = previousPath;
    await Promise.all(
      cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  /** A PATH directory, by default holding `ht-node`: a link to this node. */
  async function binDir(withNode = true): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "ht-bin-"));
    cleanup.push(directory);
    if (withNode) {
      await symlink(NODE, join(directory, "ht-node"));
    }
    return directory;
  }

  it("spawns a bare command straight from the PATH entry that holds it", async () => {
    const empty = await binDir(false);
    const notExecutable = await binDir(false);
    await writeFile(join(notExecutable, "ht-node"), "");
    const holder = await binDir();
    process.env.PATH = [empty, notExecutable, holder].join(delimiter);

    expect(await resolveCommand("ht-node")).toBe(join(holder, "ht-node"));
    expect(await directCommandRunner("ht-node", echo("ok")))
      .toEqual({ stdout: "ok", stderr: "" });
  });

  it("leaves the search to libuv when it cannot match it exactly", async () => {
    const holder = await binDir();
    // A relative entry depends on the child's cwd, so the first one stops us.
    process.env.PATH = ["relative/bin", holder].join(delimiter);
    expect(await resolveCommand("ht-node")).toBe("ht-node");

    process.env.PATH = holder;
    expect(await resolveCommand("./ht-node")).toBe("./ht-node");
    expect(await resolveCommand("ht-missing")).toBe("ht-missing");
  });

  it("searches again when PATH changes or the binary goes away", async () => {
    const first = await binDir();
    const second = await binDir();
    process.env.PATH = second;
    expect(await resolveCommand("ht-node")).toBe(join(second, "ht-node"));

    process.env.PATH = [first, second].join(delimiter);
    expect(await resolveCommand("ht-node")).toBe(join(first, "ht-node"));

    await rm(join(first, "ht-node"));
    await expect(directCommandRunner("ht-node", echo("gone")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await directCommandRunner("ht-node", echo("found")))
      .toEqual({ stdout: "found", stderr: "" });
  });
});
