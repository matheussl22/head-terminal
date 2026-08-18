import { describe, expect, it, vi } from "vitest";

import {
  decodeWslOutput,
  parseDistroList,
  toPosixPath,
  toWindowsPath,
  wrapArgv,
  wrapCommand,
  WslService,
} from "./wsl-service";

const AGENT_ARGS = ["-l", "-c", "cd /home/m/x && exec claude --resume"];

describe("wsl path translation", () => {
  const cases: Array<[string, string]> = [
    ["/home/matheus/x", "\\\\wsl.localhost\\Ubuntu\\home\\matheus\\x"],
    ["/", "\\\\wsl.localhost\\Ubuntu\\"],
    ["/mnt/c/Users/m/repo", "C:\\Users\\m\\repo"],
    ["/mnt/d", "D:\\"],
  ];

  it.each(cases)("maps %s to Windows", (posix, windows) => {
    expect(toWindowsPath(posix, "Ubuntu")).toBe(windows);
  });

  it.each([
    ["\\\\wsl.localhost\\Ubuntu\\home\\matheus\\x", "/home/matheus/x"],
    ["\\\\wsl$\\Ubuntu-22.04\\home\\m", "/home/m"],
    ["\\\\wsl.localhost\\Ubuntu", "/"],
    ["C:\\Users\\m\\repo", "/mnt/c/Users/m/repo"],
    ["c:/Users/m", "/mnt/c/Users/m"],
    ["C:\\", "/mnt/c"],
    ["/home/matheus/x", "/home/matheus/x"],
  ])("maps %s back to POSIX", (windows, posix) => {
    expect(toPosixPath(windows)).toBe(posix);
  });

  it("round-trips a WSL path", () => {
    const posix = "/home/matheus/Documentos/head-terminal";
    expect(toPosixPath(toWindowsPath(posix, "Ubuntu"))).toBe(posix);
  });

  it("leaves a relative path alone", () => {
    expect(toWindowsPath("relative/path", "Ubuntu")).toBe("relative/path");
  });
});

describe("wrapArgv", () => {
  it("hands the agent argv to Linux untouched after the separator", () => {
    const wrapped = wrapArgv("/usr/bin/zsh", AGENT_ARGS, "/home/m/x", "Ubuntu");
    expect(wrapped.file).toBe("wsl.exe");
    expect(wrapped.args).toEqual([
      "-d", "Ubuntu", "--cd", "/home/m/x", "--exec", "/usr/bin/zsh", ...AGENT_ARGS,
    ]);
    expect(wrapped.args.slice(wrapped.args.indexOf("--exec") + 2)).toEqual(AGENT_ARGS);
  });

  it("never uses the plain separator, which still goes through a shell", () => {
    // `wsl.exe -- /bin/echo '$HOME' '"$@"'` prints `/root ""`: the login shell
    // expands the argv before the program ever sees it, so an agent command
    // carrying `$?` reports a literal 0 and the resume guard never fires.
    const argv = [
      wrapArgv("/usr/bin/zsh", AGENT_ARGS, "/home/m/x", "Ubuntu"),
      wrapCommand("git", ["status"], "/home/m/x", "Ubuntu"),
      wrapCommand("printenv", ["HOME"], undefined, "Ubuntu"),
    ];
    for (const { args } of argv) {
      expect(args).toContain("--exec");
      expect(args).not.toContain("--");
    }
  });
});

describe("distro listing", () => {
  it("drops the blank lines and NULs of a UTF-16 listing", () => {
    expect(parseDistroList("U\0b\0u\0n\0t\0u\0\r\n\r\nDebian\r\n"))
      .toEqual(["Ubuntu", "Debian"]);
  });

  it("decodes UTF-16LE output and its BOM", () => {
    expect(decodeWslOutput(Buffer.from("\ufeffUbuntu\r\n", "utf16le")))
      .toBe("Ubuntu\r\n");
  });

  it("decodes plain UTF-8 output", () => {
    expect(decodeWslOutput(Buffer.from("Ubuntu\n", "utf8"))).toBe("Ubuntu\n");
  });
});

describe("WslService", () => {
  const runner = (
    distros: string,
    home = "/home/matheus\n",
    locales = "C\nC.utf8\nPOSIX\npt_BR.utf8\n",
  ) =>
    vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("printenv")) return home;
      if (args.includes("locale")) return locales;
      return distros;
    });

  it("stays inert off Windows and passes argv through", async () => {
    const service = new WslService({ platform: "linux", runner: runner("Ubuntu") });
    await service.initialize();
    expect(service.isWslMode()).toBe(false);
    expect(service.wrap("/usr/bin/zsh", AGENT_ARGS, "/home/m")).toEqual({
      file: "/usr/bin/zsh",
      args: AGENT_ARGS,
    });
    expect(service.toWindowsPath("/home/m")).toBe("/home/m");
  });

  it("picks the only distro and reads the WSL home", async () => {
    const service = new WslService({ platform: "win32", runner: runner("Ubuntu\r\n") });
    await service.initialize();
    expect(service.isWslMode()).toBe(true);
    expect(service.distro).toBe("Ubuntu");
    expect(service.home).toBe("/home/matheus");
  });

  it("honours the persisted choice among several distros", async () => {
    const service = new WslService({
      platform: "win32",
      runner: runner("Ubuntu\r\nDebian\r\n"),
      preferredDistro: "Debian",
    });
    await service.initialize();
    expect(service.distro).toBe("Debian");
    expect(service.availableDistros).toEqual(["Ubuntu", "Debian"]);
  });

  it("falls back to the first distro when the persisted one is gone", async () => {
    const service = new WslService({
      platform: "win32",
      runner: runner("Ubuntu\r\n"),
      preferredDistro: "Removed",
    });
    await service.initialize();
    expect(service.distro).toBe("Ubuntu");
    expect(await service.selectDistro("Removed")).toBe(false);
    expect(await service.selectDistro("Ubuntu")).toBe(true);
  });

  it("reports no WSL mode when the launcher fails", async () => {
    const service = new WslService({
      platform: "win32",
      runner: vi.fn(async () => { throw new Error("wsl.exe missing"); }),
    });
    await service.initialize();
    expect(service.isWslMode()).toBe(false);
    expect(service.wrap("/usr/bin/zsh", [], "/home/m").file).toBe("/usr/bin/zsh");
  });

  it("never starts the launcher itself in a UNC directory", async () => {
    const service = new WslService({
      platform: "win32",
      runner: runner("Ubuntu"),
      pathExists: () => true,
    });
    await service.initialize();
    expect(service.spawnCwd("/home/m/x", "C:\\Users\\m")).toBe("C:\\Users\\m");
    expect(service.spawnCwd("/mnt/c/repo", "C:\\Users\\m")).toBe("C:\\repo");
  });

  it("keeps a pane out of a directory the distro does not have", async () => {
    // `wsl --cd` does not fail on a missing directory: it lands in `/` and
    // prints a relay error over whatever the agent was about to draw.
    const missing = new WslService({
      platform: "win32",
      runner: runner("Ubuntu"),
      pathExists: () => false,
    });
    await missing.initialize();
    expect(missing.resolvePaneCwd("/mnt/c/Users/m/Documentos")).toBe("/home/matheus");

    const present = new WslService({
      platform: "win32",
      runner: runner("Ubuntu"),
      pathExists: () => true,
    });
    await present.initialize();
    expect(present.resolvePaneCwd("/home/m/repo")).toBe("/home/m/repo");
  });

  it("replaces a locale the distro cannot set", async () => {
    // A fresh Ubuntu carries only the C locales.
    const service = new WslService({
      platform: "win32",
      runner: runner("Ubuntu", "/home/matheus\n", "C\nC.utf8\nPOSIX\n"),
    });
    await service.initialize();

    const sanitized = service.sanitizeLocaleEnv({
      LANG: "pt_BR.utf8",
      LC_ALL: "pt_BR.utf8",
      LC_CTYPE: "pt_BR.utf8",
      TERM: "xterm-256color",
    });
    expect(sanitized.LANG).toBe("C.UTF-8");
    expect(sanitized.LC_ALL).toBe("C.UTF-8");
    expect(sanitized.TERM).toBe("xterm-256color");
  });

  it("keeps a locale the distro really has, however it is spelled", async () => {
    const service = new WslService({ platform: "win32", runner: runner("Ubuntu") });
    await service.initialize();
    // `locale -a` prints `pt_BR.utf8`; the pane asks for `pt_BR.UTF-8`.
    expect(service.sanitizeLocaleEnv({ LANG: "pt_BR.UTF-8" }).LANG).toBe("pt_BR.UTF-8");
  });

  it("falls back when the translated directory is not there", async () => {
    // CreateProcess answers ERROR_DIRECTORY for a cwd that does not exist, so
    // a stale path from a pre-WSL workspace would leave the pane unopened.
    const service = new WslService({
      platform: "win32",
      runner: runner("Ubuntu"),
      pathExists: () => false,
    });
    await service.initialize();
    expect(service.spawnCwd("/mnt/c/gone", "C:\\Users\\m")).toBe("C:\\Users\\m");
  });
});
