/**
 * End-to-end verification of what a pane actually launches on Windows, for
 * every agent profile. The only faked thing is `wsl.exe` itself: the runner is
 * injected (the seam `wsl-service` documents), so `WslService`, `PtyService`
 * and the renderer's `buildAgentProfiles` are all the production code.
 *
 * The last block goes further and hands the composed argv to real node-pty on
 * Windows, because an argv only means something if it survives the Windows
 * command-line join without being requoted or split.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { PtyService } from "../../electron/services/pty-service";
import { WslService } from "../../electron/services/wsl-service";
import { getAgentProfile } from "../../src/config/agents";

const require = createRequire(import.meta.url);

const DISTRO = "Ubuntu";
const POSIX_HOME = "/home/matheus";
const CWD = "/home/matheus/projects/head-terminal";

/** The OSC the shell wrapper emits; escapes stay literal for the distro's printf. */
const EXIT_OSC = String.raw`printf "\033]7770;agent-exited:%s\007"`;
const RESUME_OSC = String.raw`printf "\033]7771;resume-failed:%s\007"`;

/** Stands in for `wsl.exe`: distro list and the distro's own $HOME. */
function fakeWslRunner(_file: string, args: string[]): Promise<string> {
  if (args[0] === "-l") return Promise.resolve("Ubuntu\nDebian\n");
  if (args.includes("printenv")) return Promise.resolve(`${POSIX_HOME}\n`);
  return Promise.resolve("");
}

/**
 * These cases are about argv composition, so the directories are treated as
 * present; wsl-service.test.ts owns what happens when they are not.
 */
async function wslInWindowsMode(
  pathExists: (path: string) => boolean = () => true,
): Promise<WslService> {
  const wsl = new WslService({
    platform: "win32",
    runner: fakeWslRunner,
    pathExists,
  });
  await wsl.initialize();
  return wsl;
}

interface Launch {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

function stubPty() {
  return {
    pid: 4242,
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  };
}

/** Spawns a pane through the real PtyService and returns what node-pty got. */
async function launchPane(
  profileId: string,
  options?: { continueConversation?: boolean; resumeSessionId?: string },
  paneEnv: Record<string, string> = { LANG: "pt_BR.UTF-8" },
): Promise<Launch> {
  const wsl = await wslInWindowsMode();
  const seen: Launch[] = [];
  const service = new PtyService({
    wsl,
    windowsHome: "C:\\Users\\Matheus",
    env: { PATH: "/usr/bin" },
    spawn: (file, args, spawnOptions) => {
      seen.push({ file, args, cwd: spawnOptions.cwd, env: spawnOptions.env });
      return stubPty();
    },
  });

  const profile = getAgentProfile(profileId, options);
  service.spawn(7, {
    id: `pane-${profileId}`,
    command: profile.command,
    args: profile.args,
    cwd: CWD,
    env: paneEnv,
  });
  service.dispose();

  expect(seen).toHaveLength(1);
  return seen[0];
}

describe("Windows pane launch, per agent", () => {
  it("resolves the distro and its POSIX home, not the Windows one", async () => {
    const wsl = await wslInWindowsMode();
    expect(wsl.isWslMode()).toBe(true);
    expect(wsl.distro).toBe(DISTRO);
    expect(wsl.availableDistros).toEqual(["Ubuntu", "Debian"]);
    expect(wsl.home).toBe(POSIX_HOME);
  });

  it.each([
    ["claude", "claude"],
    // cursor resolves its binary name at launch, so the shim runs first.
    ["cursor", "ht_cursor"],
    ["codex", "codex"],
    ["antigravity", "agy"],
  ])("wraps a fresh %s pane into the distro", async (profileId, cli) => {
    const launch = await launchPane(profileId);

    // wsl.exe -d <distro> --cd <posix cwd> -- /usr/bin/zsh -l -c "<agent>; ..."
    expect(launch.file).toBe("wsl.exe");
    expect(launch.args.slice(0, 8)).toEqual([
      "-d",
      DISTRO,
      "--cd",
      CWD,
      // `--exec`, never `--`: the latter still runs the argv through a shell.
      "--exec",
      "/usr/bin/zsh",
      "-l",
      "-c",
    ]);
    expect(launch.args).toHaveLength(9);

    const script = launch.args[8];
    // The agent is the first thing the shell runs, shim definitions aside.
    expect(script.replace(/^ht_cursor\(\) \{.*?\}; /u, "").startsWith(`${cli};`))
      .toBe(true);
    // Agent dies -> OSC 7770 -> bare login shell, still inside the distro.
    expect(script).toContain(EXIT_OSC);
    expect(script.endsWith("exec zsh -l")).toBe(true);
  });

  it("keeps --continue on claude and cursor", async () => {
    for (const [profileId, expected] of [
      ["claude", "claude --continue;"],
      ["cursor", "ht_cursor --continue;"],
    ] as const) {
      const launch = await launchPane(profileId, { continueConversation: true });
      expect(launch.args[8]).toContain(expected);
    }
  });

  it("resumes an exact session id with a fresh-start fallback", async () => {
    const id = "8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";
    const cases = [
      ["claude", `claude --resume ${id}`, "claude"],
      ["cursor", `ht_cursor --resume ${id}`, "ht_cursor"],
      ["codex", `codex resume ${id}`, "codex"],
    ] as const;

    for (const [profileId, resumeCmd, freshCmd] of cases) {
      const script = (await launchPane(profileId, { resumeSessionId: id }))
        .args[8];
      expect(script).toContain(resumeCmd);
      // A resume that dies inside 5s starts fresh and says so via OSC 7771.
      expect(script).toContain(RESUME_OSC);
      expect(script).toContain(`${freshCmd}; fi`);
    }
  });

  it("refuses a session id that is not a plain CLI uuid", async () => {
    const script = (
      await launchPane("claude", { resumeSessionId: "abc; rm -rf ~" })
    ).args[8];
    expect(script).not.toContain("rm -rf");
    expect(script.startsWith("claude;")).toBe(true);
  });

  it("converts a cwd left behind by a pre-WSL run", async () => {
    // A workspace saved while the machine had no distro still holds Windows
    // paths. Passed through verbatim they reach CreateProcess as a literal
    // directory that does not exist there — error 267, and no pane at all.
    const wsl = await wslInWindowsMode();
    const seen: Launch[] = [];
    const service = new PtyService({
      wsl,
      windowsHome: "C:\\Users\\Matheus",
      env: { PATH: "/usr/bin" },
      spawn: (file, args, o) => {
        seen.push({ file, args, cwd: o.cwd, env: o.env });
        return stubPty();
      },
    });
    const profile = getAgentProfile("claude");
    service.spawn(8, {
      id: "pane-stale",
      command: profile.command,
      args: profile.args,
      cwd: "C:\\ht-missing-dir\\repo",
      env: {},
    });
    service.dispose();

    // --cd carries a POSIX path, never the Windows spelling it was saved as.
    expect(seen[0].args[3]).toBe("/mnt/c/ht-missing-dir/repo");
  });

  it("starts the Windows launcher in a real Windows directory", async () => {
    // CreateProcess refuses a UNC cwd; --cd already carries the POSIX one.
    const launch = await launchPane("claude");
    expect(launch.cwd).toBe("C:\\Users\\Matheus");
    expect(launch.args[3]).toBe(CWD);
  });

  it("carries the pane env across the boundary through WSLENV", async () => {
    const launch = await launchPane("claude");
    expect(launch.env.LANG).toBe("pt_BR.UTF-8");
    expect(launch.env.TERM).toBe("xterm-256color");
    expect(launch.env.COLORTERM).toBe("truecolor");
    expect(launch.env.HEAD_TERMINAL_PANE).toMatch(/^[0-9a-f-]{36}$/u);

    const carried = launch.env.WSLENV.split(":");
    expect(carried).toContain("TERM");
    expect(carried).toContain("COLORTERM");
    expect(carried).toContain("LANG");
    expect(carried).toContain("HEAD_TERMINAL_PANE");
  });

  it("gives each Claude pane its own account config dir", async () => {
    const configDir = `${POSIX_HOME}/.head-terminal/claude-profiles/a`;
    const launch = await launchPane("claude", undefined, {
      CLAUDE_CONFIG_DIR: configDir,
    });

    expect(launch.env.CLAUDE_CONFIG_DIR).toBe(configDir);
    expect(launch.env.WSLENV.split(":")).toContain("CLAUDE_CONFIG_DIR");
  });
});

describe("the composed argv survives real node-pty on Windows", () => {
  it.runIf(process.platform === "win32")(
    "hands every word to the child unchanged",
    async () => {
      const { spawn } = require("node-pty") as {
        spawn: (
          file: string,
          args: string[],
          options: Record<string, unknown>,
        ) => { onExit(listener: (e: { exitCode: number }) => void): unknown };
      };

      // The real wrapped argv, with wsl.exe swapped for a program that reports
      // the argv it was actually given. Everything else is byte-identical.
      const launch = await launchPane("claude");
      const dir = mkdtempSync(join(tmpdir(), "ht-argv-"));
      const outFile = join(dir, "argv.json");
      const echoScript = join(dir, "echo-argv.cjs");
      writeFileSync(
        echoScript,
        `require("fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n`,
      );

      const child = spawn(
        process.execPath,
        [echoScript, outFile, ...launch.args],
        {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: tmpdir(),
          env: { ...process.env } as Record<string, string>,
        },
      );

      const exitCode = await new Promise<number>((resolve) => {
        child.onExit(({ exitCode: code }) => resolve(code));
      });
      expect(exitCode).toBe(0);
      expect(JSON.parse(readFileSync(outFile, "utf8"))).toEqual(launch.args);
    },
    20_000,
  );
});
