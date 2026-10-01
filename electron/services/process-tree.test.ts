import { describe, expect, it } from "vitest";

import {
  inspectProcessTree,
  parsePosixProcessTable,
  parseWindowsProcessTable,
  type ProcessRow,
} from "./process-tree";

function row(pid: number, ppid: number, name: string, memoryBytes = 1_000): ProcessRow {
  return { pid, ppid, name, memoryBytes };
}

describe("parseWindowsProcessTable", () => {
  it("reads pid, parent, working set and the lower-cased name", () => {
    const rows = parseWindowsProcessTable(
      "0\t0\t8192\tSystem Idle Process\r\n39644\t38960\t42840064\tpwsh.exe\r\n27940\t39644\t338403328\tclaude.exe\r\n\r\n",
    );
    expect(rows).toEqual([
      row(39644, 38960, "pwsh.exe", 42840064),
      row(27940, 39644, "claude.exe", 338403328),
    ]);
  });
});

describe("parsePosixProcessTable", () => {
  it("turns RSS KiB into bytes and keeps only the command's base name", () => {
    const rows = parsePosixProcessTable(
      "  501   1  2048 /bin/zsh\n  777 501 300000 /Users/me/.local/bin/2.1.283\n",
    );
    expect(rows).toEqual([
      row(501, 1, "zsh", 2048 * 1024),
      row(777, 501, "2.1.283", 300000 * 1024),
    ]);
  });
});

describe("inspectProcessTree", () => {
  it("says a pane whose root is gone is not alive", () => {
    expect(inspectProcessTree([row(1, 0, "init")], 42)).toEqual({
      alive: false,
      memoryBytes: 0,
      children: [],
      detachedShells: [],
    });
  });

  it("sums the memory of the whole tree, and of nothing else", () => {
    const rows = [
      row(10, 1, "pwsh.exe", 40),
      row(11, 10, "claude.exe", 300),
      row(12, 11, "node.exe", 60),
      row(99, 1, "unrelated.exe", 5_000),
    ];
    expect(inspectProcessTree(rows, 10).memoryBytes).toBe(400);
  });

  it("sees an idle shell pane with nothing under it", () => {
    const rows = [row(10, 1, "pwsh.exe"), row(11, 10, "conhost.exe")];
    expect(inspectProcessTree(rows, 10)).toMatchObject({
      alive: true,
      children: [],
      detachedShells: [],
    });
  });

  it("lists what a shell pane runs (a dev server, claude typed by hand)", () => {
    const rows = [row(10, 1, "pwsh.exe"), row(11, 10, "node.exe"), row(12, 11, "esbuild.exe")];
    expect(inspectProcessTree(rows, 10).children.sort()).toEqual(["esbuild.exe", "node.exe"]);
  });

  it("does not count MCP servers an idle agent keeps as background work", () => {
    // claude → `cmd /c npx …` → node: plumbing that lives as long as the agent.
    const rows = [
      row(10, 1, "pwsh.exe"),
      row(11, 10, "claude.exe"),
      row(12, 11, "cmd.exe"),
      row(13, 12, "node.exe"),
      row(14, 11, "uvx.exe"),
    ];
    expect(inspectProcessTree(rows, 10).detachedShells).toEqual([]);
  });

  it("flags a shell an agent left running in the background", () => {
    const rows = [
      row(10, 1, "pwsh.exe"),
      row(11, 10, "claude.exe"),
      row(12, 11, "bash.exe"),
      row(13, 12, "node.exe"),
    ];
    expect(inspectProcessTree(rows, 10).detachedShells).toEqual(["bash.exe"]);
  });

  it("does not take a CLI's own shell shim for background work", () => {
    // pwsh → cmd (cursor-agent.cmd) → node: shells launched by shells.
    const rows = [
      row(10, 1, "pwsh.exe"),
      row(11, 10, "cmd.exe"),
      row(12, 11, "node.exe"),
    ];
    expect(inspectProcessTree(rows, 10).detachedShells).toEqual([]);
  });

  it("flags a POSIX agent's background shell", () => {
    const rows = [
      row(500, 1, "zsh"),
      row(501, 500, "2.1.283"),
      row(502, 501, "zsh"),
      row(503, 502, "node"),
    ];
    expect(inspectProcessTree(rows, 500).detachedShells).toEqual(["zsh"]);
  });

  it("survives a cycle in a corrupt table", () => {
    const rows = [row(10, 1, "pwsh.exe"), row(11, 12, "a.exe"), row(12, 11, "b.exe"), row(13, 10, "c.exe")];
    expect(inspectProcessTree(rows, 10).children).toEqual(["c.exe"]);
  });
});
