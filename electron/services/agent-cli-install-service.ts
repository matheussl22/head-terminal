import { copyFile, link, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  directCommandRunner,
  runCommand,
  type CommandRunner,
} from "./command-runner";
import {
  checkAgentClis,
  type AgentCliStatus,
} from "./system-service";

export type InstallableAgentId = "cursor" | "claude" | "codex";

export interface AgentCliInstallResult {
  status: AgentCliStatus;
  installed: InstallableAgentId[];
  failed: Array<{ id: InstallableAgentId; error: string }>;
}

export type AgentInstaller = () => Promise<void>;

export interface EnsureAgentClisOptions {
  check?: () => Promise<AgentCliStatus>;
  installers?: Partial<Record<InstallableAgentId, AgentInstaller>>;
  refreshPath?: () => Promise<void>;
  nativeWindows?: boolean;
  skip?: boolean;
}

const INSTALL_TIMEOUT_MS = 6 * 60 * 1000;
const INSTALLABLE: InstallableAgentId[] = ["cursor", "claude", "codex"];
const CURSOR_INSTALL_SCRIPT = "https://cursor.com/install?win32=true";
const CURSOR_FALLBACK = {
  version: "2026.08.11-e8db854",
  urlPrefix: "https://downloads.cursor.com/lab/2026.08.11-e8db854/",
};

let nativeWindowsInstallers = process.platform === "win32";
let inFlight: Promise<AgentCliInstallResult> | null = null;

export function configureAgentCliInstaller(options: { wslMode: boolean }): void {
  nativeWindowsInstallers = process.platform === "win32" && !options.wslMode;
}

function missingAgents(status: AgentCliStatus): InstallableAgentId[] {
  return INSTALLABLE.filter((id) => !status[id]);
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function refreshWindowsPath(): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  const read = (scope: "Machine" | "User") =>
    directCommandRunner("powershell.exe", [
      "-NoProfile",
      "-Command",
      `[Environment]::GetEnvironmentVariable('PATH','${scope}')`,
    ], { timeoutMs: 8_000 }).then(
      (result) => result.stdout.trim(),
      () => "",
    );
  const [machine, user] = await Promise.all([read("Machine"), read("User")]);
  const parts = [machine, user].filter((part) => part.length > 0);
  if (parts.length > 0) {
    process.env.PATH = parts.join(";");
  }
}

async function prependUserPath(directory: string): Promise<void> {
  const current = process.env.PATH ?? "";
  if (!current.toLowerCase().includes(directory.toLowerCase())) {
    process.env.PATH = `${directory};${current}`;
  }
  if (process.platform !== "win32") {
    return;
  }
  const user = await directCommandRunner("powershell.exe", [
    "-NoProfile",
    "-Command",
    "[Environment]::GetEnvironmentVariable('PATH','User')",
  ], { timeoutMs: 8_000 }).then((result) => result.stdout.trim(), () => "");
  if (user.toLowerCase().includes(directory.toLowerCase())) {
    return;
  }
  const next = user.length > 0 ? `${user};${directory}` : directory;
  await directCommandRunner("powershell.exe", [
    "-NoProfile",
    "-Command",
    `[Environment]::SetEnvironmentVariable('PATH', ${JSON.stringify(next)}, 'User')`,
  ], { timeoutMs: 8_000 }).catch(() => undefined);
}

function wingetPath(): string {
  const fromEnv = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "winget.exe")
    : "";
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }
  return "winget.exe";
}

async function wingetInstall(packageId: string): Promise<void> {
  await directCommandRunner(wingetPath(), [
    "install",
    "--id",
    packageId,
    "-e",
    "--accept-package-agreements",
    "--accept-source-agreements",
    "--disable-interactivity",
  ], { timeoutMs: INSTALL_TIMEOUT_MS });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Falha ao baixar ${url} (${response.status})`);
  }
  await writeFile(dest, Buffer.from(await response.arrayBuffer()));
}

async function parseCursorWindowsRelease(): Promise<{ version: string; urlPrefix: string }> {
  try {
    const response = await fetch(CURSOR_INSTALL_SCRIPT);
    if (!response.ok) {
      return CURSOR_FALLBACK;
    }
    const script = await response.text();
    const urlPrefix = script.match(/\$downloadUrl = '([^']+)'/u)?.[1];
    const version = script.match(/\$version = '([^']+)'/u)?.[1];
    if (urlPrefix && version) {
      return { version, urlPrefix };
    }
  } catch {
    // Fall through to the last known official package.
  }
  return CURSOR_FALLBACK;
}

async function installCursorWindows(): Promise<void> {
  const { version, urlPrefix } = await parseCursorWindowsRelease();
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const zipUrl = `${urlPrefix}windows/${arch}/agent-cli-package.zip`;
  const agentPath = join(process.env.LOCALAPPDATA ?? homedir(), "cursor-agent");
  const versionsPath = join(agentPath, "versions");
  const zip = join(tmpdir(), `cursor-agent-${version}.zip`);

  await mkdir(versionsPath, { recursive: true });
  await downloadFile(zipUrl, zip);
  await directCommandRunner("tar", ["-xf", zip, "-C", versionsPath], {
    timeoutMs: 60_000,
  });
  const extracted = join(versionsPath, "dist-package");
  const versionDir = join(versionsPath, version);
  if (existsSync(extracted) && !existsSync(versionDir)) {
    await rename(extracted, versionDir);
  }
  const sourceDir = existsSync(versionDir) ? versionDir : extracted;
  const entries = await readdir(sourceDir);
  for (const name of entries.filter((entry) => entry.startsWith("cursor-agent"))) {
    await copyFile(join(sourceDir, name), join(agentPath, name));
  }
  for (const name of ["cursor-agent.exe", "cursor-agent.cmd", "cursor-agent.ps1"]) {
    const src = join(agentPath, name);
    if (existsSync(src)) {
      await copyFile(src, join(agentPath, name.replace(/^cursor-agent/u, "agent")));
    }
  }
  await prependUserPath(agentPath);
}

async function ensureCodexShim(): Promise<void> {
  const root = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages")
    : "";
  if (!root || !existsSync(root)) {
    return;
  }
  const packages = await readdir(root);
  const pkg = packages.find((name) => name.startsWith("OpenAI.Codex_"));
  if (!pkg) {
    return;
  }
  const dir = join(root, pkg);
  const dest = join(dir, "codex.exe");
  if (existsSync(dest)) {
    await prependUserPath(dir);
    return;
  }
  const files = await readdir(dir);
  const binary = files.find((name) => /^codex-.*-pc-windows-msvc\.exe$/u.test(name));
  if (!binary) {
    return;
  }
  const src = join(dir, binary);
  await link(src, dest).catch(() => copyFile(src, dest));
  await prependUserPath(dir);
}

async function posixInstall(script: string): Promise<void> {
  const runner: CommandRunner = runCommand;
  await runner("bash", ["-lc", script], { timeoutMs: INSTALL_TIMEOUT_MS });
}

const defaultWindowsInstallers: Record<InstallableAgentId, AgentInstaller> = {
  claude: async () => {
    await wingetInstall("Anthropic.ClaudeCode");
    await refreshWindowsPath();
  },
  cursor: installCursorWindows,
  codex: async () => {
    await wingetInstall("OpenAI.Codex");
    await refreshWindowsPath();
    await ensureCodexShim();
  },
};

const defaultPosixInstallers: Record<InstallableAgentId, AgentInstaller> = {
  claude: () => posixInstall("curl -fsSL https://claude.ai/install.sh | bash"),
  cursor: () => posixInstall("curl https://cursor.com/install -fsS | bash"),
  codex: () => posixInstall("curl -fsSL https://chatgpt.com/codex/install.sh | sh"),
};

export async function ensureAgentClis(
  options: EnsureAgentClisOptions = {},
): Promise<AgentCliInstallResult> {
  const skip = options.skip ?? (
    process.env.HEAD_TERMINAL_SMOKE === "1"
    || process.env.HEAD_TERMINAL_SKIP_CLI_INSTALL === "1"
  );
  const check = options.check ?? checkAgentClis;
  const nativeWindows = options.nativeWindows ?? nativeWindowsInstallers;
  const installers = {
    ...(nativeWindows ? defaultWindowsInstallers : defaultPosixInstallers),
    ...options.installers,
  };
  const refreshPath = options.refreshPath
    ?? (nativeWindows ? refreshWindowsPath : async () => undefined);

  const run = async (): Promise<AgentCliInstallResult> => {
    const initial = await check();
    if (skip) {
      return { status: initial, installed: [], failed: [] };
    }
    const pending = missingAgents(initial);
    const installed: InstallableAgentId[] = [];
    const failed: AgentCliInstallResult["failed"] = [];
    for (const id of pending) {
      try {
        await installers[id]();
        installed.push(id);
      } catch (error) {
        failed.push({ id, error: asErrorMessage(error) });
      }
    }
    if (installed.length > 0) {
      await refreshPath();
    }
    return {
      status: installed.length > 0 || failed.length > 0 ? await check() : initial,
      installed,
      failed,
    };
  };

  if (options.check || options.installers) {
    return run();
  }
  if (!inFlight) {
    inFlight = run().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
