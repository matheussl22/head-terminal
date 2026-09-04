import { describe, expect, it } from "vitest";

import {
  basenamePath,
  isWindowsPath,
  joinPath,
  legacyPosixToWindowsPath,
} from "./path-utils";

describe("path-utils", () => {
  it("takes the last segment whichever separator the path uses", () => {
    expect(basenamePath("C:\\Users\\m\\head-terminal")).toBe("head-terminal");
    expect(basenamePath("C:/Users/m/head-terminal/")).toBe("head-terminal");
    expect(basenamePath("/home/m/proj")).toBe("proj");
    expect(basenamePath("C:\\", "Head")).toBe("C:");
    expect(basenamePath("", "Head")).toBe("Head");
  });

  it("joins with the separator the base already uses", () => {
    expect(joinPath("C:\\Users\\m", ".head-terminal", "x")).toBe("C:\\Users\\m\\.head-terminal\\x");
    expect(joinPath("C:\\Users\\m\\", "x")).toBe("C:\\Users\\m\\x");
    expect(joinPath("/home/m/", ".head-terminal", "x")).toBe("/home/m/.head-terminal/x");
  });

  it("recognises drive and UNC paths", () => {
    expect(isWindowsPath("C:\\x")).toBe(true);
    expect(isWindowsPath("c:/x")).toBe(true);
    expect(isWindowsPath("\\\\server\\share")).toBe(true);
    expect(isWindowsPath("/mnt/c/x")).toBe(false);
    expect(isWindowsPath("relative\\x")).toBe(false);
  });

  it("translates only WSL mount paths back to a drive", () => {
    expect(legacyPosixToWindowsPath("/mnt/c/Users/m/proj")).toBe("C:\\Users\\m\\proj");
    expect(legacyPosixToWindowsPath("/mnt/d")).toBe("D:\\");
    expect(legacyPosixToWindowsPath("/home/m/proj")).toBeNull();
    expect(legacyPosixToWindowsPath("C:\\already")).toBeNull();
  });
});
