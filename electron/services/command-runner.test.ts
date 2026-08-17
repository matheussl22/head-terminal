import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWslCommandRunner,
  directCommandRunner,
  resetCommandRunner,
  runCommand,
  setCommandRunner,
  type CommandFailure,
} from "./command-runner";

afterEach(() => resetCommandRunner());

describe("command-runner", () => {
  it("resolves with the child output", async () => {
    expect(await directCommandRunner("/bin/echo", ["hi"]))
      .toEqual({ stdout: "hi\n", stderr: "" });
  });

  it("keeps stderr on the rejection so callers can report it", async () => {
    const failure = await directCommandRunner(
      "/bin/sh",
      ["-c", "echo boom >&2; exit 3"],
    ).catch((error: CommandFailure) => error);

    expect((failure as CommandFailure).stderr).toBe("boom\n");
  });

  it("runs the command through the distro when WSL mode is on", async () => {
    const wrapCommand = vi.fn((command: string, args: readonly string[], cwd?: string) => ({
      // Stands in for `wsl.exe -d Ubuntu --cd <cwd> -- <command>`.
      file: "/bin/echo",
      args: ["-d", "Ubuntu", "--cd", cwd ?? "", "--", command, ...args],
    }));
    const runner = createWslCommandRunner({ isWslMode: () => true, wrapCommand });

    const result = await runner("git", ["status"], { cwd: "/home/m/repo" });

    expect(wrapCommand).toHaveBeenCalledWith("git", ["status"], "/home/m/repo");
    expect(result.stdout.trim())
      .toBe("-d Ubuntu --cd /home/m/repo -- git status");
  });

  it("stays out of the way when WSL mode is off", async () => {
    const wrapCommand = vi.fn();
    const runner = createWslCommandRunner({ isWslMode: () => false, wrapCommand });

    expect(await runner("/bin/echo", ["direct"])).toEqual({
      stdout: "direct\n",
      stderr: "",
    });
    expect(wrapCommand).not.toHaveBeenCalled();
  });

  it("routes every caller through the runner installed at startup", async () => {
    const installed = vi.fn(async () => ({ stdout: "stub", stderr: "" }));
    setCommandRunner(installed);

    expect(await runCommand("git", ["status"])).toEqual({ stdout: "stub", stderr: "" });
    expect(installed).toHaveBeenCalledWith("git", ["status"], undefined);
  });
});
