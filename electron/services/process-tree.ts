import { execFile } from "node:child_process";

import type { PaneProcessInspection } from "../types/api";
import { resolvePowerShell } from "./windows-shell";

/** One row of the machine's process table. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Executable name, lower-cased, without directory (`claude.exe`). */
  name: string;
  /** Resident memory (working set on Windows, RSS elsewhere). */
  memoryBytes: number;
}

/** Hosts ConPTY or the console starts next to a shell; never the user's. */
const CONSOLE_HOSTS = new Set(["conhost.exe", "openconsole.exe"]);

/**
 * Shells. Under an agent, one of these is a command the agent started —
 * Claude's Bash/PowerShell tools — and an agent that is idle only still has
 * one when it was sent to the background (a dev server, a watcher). `cmd` is
 * not among them on purpose: Windows MCP servers are launched as
 * `cmd /c npx …` and live as long as the agent does.
 */
const SHELL_NAMES = new Set([
  "bash",
  "sh",
  "dash",
  "zsh",
  "fish",
  "nu",
  "pwsh",
  "powershell",
  "wsl",
]);

function baseName(name: string): string {
  const leaf = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  return leaf.toLowerCase();
}

function isShell(name: string): boolean {
  return SHELL_NAMES.has(name.replace(/\.exe$/u, ""));
}

/** `pid\tppid\tbytes\tname` lines, as the Windows query below prints them. */
export function parseWindowsProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const [pid, ppid, bytes, ...name] = line.split("\t");
    const row = {
      pid: Number(pid),
      ppid: Number(ppid),
      memoryBytes: Number(bytes),
      name: baseName(name.join("\t").trim()),
    };
    if (Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.ppid) && row.name) {
      rows.push({ ...row, memoryBytes: Number.isFinite(row.memoryBytes) ? row.memoryBytes : 0 });
    }
  }
  return rows;
}

/** `ps -eo pid=,ppid=,rss=,comm=` — rss in KiB, comm a path on macOS. */
export function parsePosixProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      memoryBytes: Number(match[3]) * 1024,
      name: baseName(match[4]),
    });
  }
  return rows;
}

const WINDOWS_QUERY =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,Name"
  + " | ForEach-Object { \"{0}`t{1}`t{2}`t{3}\" -f $_.ProcessId,$_.ParentProcessId,$_.WorkingSetSize,$_.Name }";

/**
 * The whole process table. About a second on Windows (a PowerShell CIM
 * query), so it is read on demand — when a session is about to be put to
 * sleep — and never polled.
 */
export function readProcessTable(platform: NodeJS.Platform = process.platform): Promise<ProcessRow[]> {
  return new Promise((resolve, reject) => {
    const done = (parse: (stdout: string) => ProcessRow[]) =>
      (error: Error | null, stdout: string) => (error ? reject(error) : resolve(parse(stdout)));
    if (platform === "win32") {
      execFile(
        resolvePowerShell(),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_QUERY],
        { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
        done(parseWindowsProcessTable),
      );
      return;
    }
    execFile(
      "ps",
      ["-eo", "pid=,ppid=,rss=,comm="],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024 },
      done(parsePosixProcessTable),
    );
  });
}

/**
 * What runs under a pane's root process (the shell node-pty started), as far
 * as putting it to sleep is concerned:
 * - `memoryBytes`: the root and everything below it.
 * - `children`: names of what runs under the root, console hosts aside — a
 *   shell pane with any is busy (a dev server, an agent typed by hand).
 * - `detachedShells`: shells started by something that is not a shell — an
 *   agent's background command. A shell launched by a shell (the `cmd`
 *   shim of a CLI, the profile's wrapper) is plumbing, not work.
 */
export function inspectProcessTree(rows: readonly ProcessRow[], rootPid: number): PaneProcessInspection {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const childrenOf = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const siblings = childrenOf.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenOf.set(row.ppid, [row]);
  }

  const root = byPid.get(rootPid);
  if (!root) {
    return { alive: false, memoryBytes: 0, children: [], detachedShells: [] };
  }

  let memoryBytes = root.memoryBytes;
  const children: string[] = [];
  const detachedShells: string[] = [];
  const seen = new Set<number>([rootPid]);
  // [process, has a non-shell ancestor below the root]
  const stack: Array<[ProcessRow, boolean]> = (childrenOf.get(rootPid) ?? []).map((row) => [row, false]);
  while (stack.length > 0) {
    const [row, underProgram] = stack.pop() as [ProcessRow, boolean];
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    memoryBytes += row.memoryBytes;
    if (!CONSOLE_HOSTS.has(row.name)) {
      children.push(row.name);
      if (underProgram && isShell(row.name)) {
        detachedShells.push(row.name);
      }
    }
    const nextUnderProgram = underProgram || (!isShell(row.name) && !CONSOLE_HOSTS.has(row.name) && row.name !== "cmd.exe");
    for (const child of childrenOf.get(row.pid) ?? []) {
      stack.push([child, nextUnderProgram]);
    }
  }
  return { alive: true, memoryBytes, children, detachedShells };
}
