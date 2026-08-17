import { describe, expect, it } from "vitest";

import { appDataRoot, localAppData } from "./platform-paths";

const home = "/home/matheus";

describe("platform-paths", () => {
  it("keeps the XDG layout on Linux", () => {
    expect(appDataRoot({ platform: "linux", env: {}, home }))
      .toBe("/home/matheus/.local/share/head-terminal");
  });

  it("keeps the historical dotfile layout on macOS", () => {
    expect(appDataRoot({ platform: "darwin", env: {}, home }))
      .toBe("/home/matheus/.head-terminal");
  });

  it("uses LOCALAPPDATA on Windows", () => {
    const environment = {
      platform: "win32" as const,
      env: { LOCALAPPDATA: "C:\\Users\\m\\AppData\\Local" },
      home: "C:\\Users\\m",
    };
    expect(localAppData(environment)).toBe("C:\\Users\\m\\AppData\\Local");
    expect(appDataRoot(environment)).toContain("head-terminal");
  });

  it("falls back to the documented path when LOCALAPPDATA is unset", () => {
    expect(localAppData({ platform: "win32", env: {}, home: "C:\\Users\\m" }))
      .toContain("AppData");
  });
});
