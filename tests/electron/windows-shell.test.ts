import { describe, expect, it } from "vitest";

import {
  legacyPosixToWindowsPath,
  resolvePowerShell,
  resolveWindowsCwd,
} from "../../electron/services/windows-shell";

const ENV = {
  ProgramFiles: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\m\\AppData\\Local",
  SystemRoot: "C:\\WINDOWS",
};

describe("resolvePowerShell", () => {
  it("prefers PowerShell 7 from Program Files", () => {
    const present = new Set(["C:\\Program Files\\PowerShell\\7\\pwsh.exe"]);
    expect(resolvePowerShell({ env: ENV, exists: (path) => present.has(path) }))
      .toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  });

  it("takes the Store install through its app execution alias", () => {
    // The alias is a reparse point: `stat` fails with EACCES, only `lstat`
    // sees it — which is what the default `exists` uses.
    const present = new Set(["C:\\Users\\m\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe"]);
    expect(resolvePowerShell({ env: ENV, exists: (path) => present.has(path) }))
      .toBe("C:\\Users\\m\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe");
  });

  it("falls back to Windows PowerShell 5.1, which every build ships", () => {
    expect(resolvePowerShell({ env: ENV, exists: () => false }))
      .toBe("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });
});

describe("resolveWindowsCwd", () => {
  const existing = new Set(["C:\\Users\\m\\repo", "C:\\Users\\m"]);
  const exists = (path: string) => existing.has(path);

  it("keeps an existing native folder and normalises the separator", () => {
    expect(resolveWindowsCwd("C:\\Users\\m\\repo", "C:\\Users\\m", exists)).toBe("C:\\Users\\m\\repo");
    expect(resolveWindowsCwd("C:/Users/m/repo", "C:\\Users\\m", exists)).toBe("C:\\Users\\m\\repo");
  });

  it("translates a WSL-era mount path and falls back otherwise", () => {
    expect(resolveWindowsCwd("/mnt/c/Users/m/repo", "C:\\Users\\m", exists)).toBe("C:\\Users\\m\\repo");
    expect(resolveWindowsCwd("/home/m/repo", "C:\\Users\\m", exists)).toBe("C:\\Users\\m");
    expect(resolveWindowsCwd("C:\\Users\\m\\gone", "C:\\Users\\m", exists)).toBe("C:\\Users\\m");
    expect(resolveWindowsCwd("relative", "C:\\Users\\m", exists)).toBe("C:\\Users\\m");
  });

  it("maps mount roots and rejects other POSIX paths", () => {
    expect(legacyPosixToWindowsPath("/mnt/d")).toBe("D:\\");
    expect(legacyPosixToWindowsPath("/tmp")).toBeNull();
  });
});
