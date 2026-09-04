import { afterEach, describe, expect, it, vi } from "vitest";

import {
  directCommandRunner,
  resetCommandRunner,
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
