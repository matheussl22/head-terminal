import { watch as watchFs, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  createSessionWorktree,
  getGitContext,
  getSessionDiff,
  type GitContextPayload,
} from "./git-service";

const WATCH_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/u;
const DEBOUNCE_MS = 120;
/** Polling cadence in WSL mode. Long enough that a `wsl.exe` git call per
 * repository stays cheap, short enough that a commit shows up quickly. */
const DEFAULT_POLL_INTERVAL_MS = 4_000;

export interface GitWatchInput {
  watchId: string;
  cwd: string;
}

export interface GitContextChangedEvent {
  watchId: string;
  context: GitContextPayload;
}

export type GitContextChangedListener = (
  event: GitContextChangedEvent,
) => void;

interface RepoWatch {
  fsWatchers: FSWatcher[];
  pollTimer: ReturnType<typeof setInterval> | null;
  /** Last context emitted, so polling only speaks when something changed. */
  lastContext: string | null;
  subscribers: Set<string>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  refreshing: boolean;
  refreshAgain: boolean;
}

function validateWatchId(watchId: string): string {
  if (typeof watchId !== "string" || !WATCH_ID_PATTERN.test(watchId)) {
    throw new Error("Identificador de watcher inválido");
  }
  return watchId;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Resolves both normal `.git` directories and worktree `.git` pointer files. */
async function resolveGitDir(repoRoot: string): Promise<string> {
  const dotGit = join(repoRoot, ".git");
  const info = await stat(dotGit);
  if (info.isDirectory()) {
    return dotGit;
  }
  if (!info.isFile()) {
    throw new Error("Não foi possível resolver o diretório .git");
  }

  const pointer = await readFile(dotGit, "utf8");
  const match = /^gitdir:\s*(.+)\s*$/imu.exec(pointer);
  if (!match) {
    throw new Error("Ponteiro .git inválido");
  }
  const target = match[1].trim();
  return resolve(repoRoot, target);
}

async function resolveCommonGitDir(gitDir: string): Promise<string> {
  try {
    const common = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
    if (!common || common.includes("\0")) {
      return gitDir;
    }
    return isAbsolute(common) ? resolve(common) : resolve(gitDir, common);
  } catch {
    return gitDir;
  }
}

async function watchDirectories(repoRoot: string): Promise<string[]> {
  const gitDir = await resolveGitDir(repoRoot);
  if (!(await isDirectory(gitDir))) {
    throw new Error("Não foi possível resolver o diretório .git");
  }
  const commonGitDir = await resolveCommonGitDir(gitDir);
  const paths = new Set<string>([gitDir, commonGitDir]);

  // Watching directory entries survives Git's atomic replacement of HEAD,
  // index and packed-refs, unlike an inode-bound watch of those files.
  const refsHeads = join(commonGitDir, "refs", "heads");
  if (await isDirectory(refsHeads)) {
    paths.add(refsHeads);
  }

  // Include the current symbolic-ref parent for branches such as feature/foo.
  try {
    const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
    if (head.startsWith("ref: ")) {
      const refPath = resolve(commonGitDir, head.slice(5));
      if (refPath.startsWith(`${commonGitDir}/`)) {
        const parent = dirname(refPath);
        if (await isDirectory(parent)) {
          paths.add(parent);
        }
      }
    }
  } catch {
    // An unborn/detached repository can still be watched through gitDir.
  }
  return [...paths];
}

export interface GitWatchServiceOptions {
  /**
   * Set on Windows: inotify events do not cross the 9p/virtiofs boundary, so
   * a `\\wsl.localhost` watch is simply silent. Polling is the honest
   * fallback there and stays off everywhere else.
   */
  pollIntervalMs?: number;
}

export class GitWatchService {
  private readonly repos = new Map<string, RepoWatch>();
  private readonly watchIdRepos = new Map<string, string>();
  private readonly listeners = new Set<GitContextChangedListener>();
  private readonly pollIntervalMs: number;

  constructor(options: GitWatchServiceOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 0;
  }

  public onChanged(listener: GitContextChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async watch(input: GitWatchInput): Promise<void> {
    const watchId = validateWatchId(input.watchId);
    const context = await getGitContext(input.cwd);
    const repoRoot = context.repoRoot;
    const previousRepo = this.watchIdRepos.get(watchId);

    if (!repoRoot) {
      this.detach(watchId);
      this.emit({ watchId, context });
      return;
    }

    if (previousRepo !== repoRoot) {
      this.detach(watchId);
      let repoWatch = this.repos.get(repoRoot);
      if (!repoWatch) {
        repoWatch = await this.createRepoWatch(repoRoot);
        this.repos.set(repoRoot, repoWatch);
      }
      repoWatch.subscribers.add(watchId);
      this.watchIdRepos.set(watchId, repoRoot);
    }

    // The subscriber gets this context now, so the first poll has nothing new
    // to say about it.
    const activeWatch = this.repos.get(repoRoot);
    if (activeWatch) activeWatch.lastContext = JSON.stringify(context);
    this.emit({ watchId, context });
  }

  public async unwatch(watchId: string): Promise<void> {
    this.detach(validateWatchId(watchId));
  }

  public dispose(): void {
    for (const repoWatch of this.repos.values()) {
      this.closeRepoWatch(repoWatch);
    }
    this.repos.clear();
    this.watchIdRepos.clear();
    this.listeners.clear();
  }

  /** Exposed for diagnostics and deterministic refcount tests. */
  public get watchedRepoCount(): number {
    return this.repos.size;
  }

  public isPolling(): boolean {
    return this.pollIntervalMs > 0;
  }

  public subscriberCount(repoRoot: string): number {
    return this.repos.get(repoRoot)?.subscribers.size ?? 0;
  }

  private async createRepoWatch(repoRoot: string): Promise<RepoWatch> {
    const repoWatch: RepoWatch = {
      fsWatchers: [],
      pollTimer: null,
      lastContext: null,
      subscribers: new Set(),
      debounceTimer: null,
      refreshing: false,
      refreshAgain: false,
    };

    if (this.pollIntervalMs > 0) {
      repoWatch.pollTimer = setInterval(
        () => void this.refresh(repoRoot, repoWatch),
        this.pollIntervalMs,
      );
      repoWatch.pollTimer.unref?.();
      return repoWatch;
    }

    try {
      for (const directory of await watchDirectories(repoRoot)) {
        const watcher = watchFs(
          directory,
          { persistent: false, encoding: "utf8" },
          () => this.scheduleRefresh(repoRoot, repoWatch),
        );
        // A watcher error must not crash the Electron main process. Polling in
        // the renderer remains the fallback if an underlying watch is lost.
        watcher.on("error", () => undefined);
        repoWatch.fsWatchers.push(watcher);
      }
      return repoWatch;
    } catch (error) {
      this.closeRepoWatch(repoWatch);
      throw error;
    }
  }

  private scheduleRefresh(repoRoot: string, repoWatch: RepoWatch): void {
    if (this.repos.get(repoRoot) !== repoWatch) {
      return;
    }
    if (repoWatch.debounceTimer !== null) {
      clearTimeout(repoWatch.debounceTimer);
    }
    repoWatch.debounceTimer = setTimeout(() => {
      repoWatch.debounceTimer = null;
      void this.refresh(repoRoot, repoWatch);
    }, DEBOUNCE_MS);
  }

  private async refresh(repoRoot: string, repoWatch: RepoWatch): Promise<void> {
    if (repoWatch.refreshing) {
      repoWatch.refreshAgain = true;
      return;
    }
    repoWatch.refreshing = true;
    try {
      const context = await getGitContext(repoRoot);
      if (this.repos.get(repoRoot) !== repoWatch) {
        return;
      }
      // Polling wakes up on a clock, not on a change: repeating an identical
      // context would be pure noise for every subscriber.
      const serialized = JSON.stringify(context);
      if (this.pollIntervalMs > 0 && repoWatch.lastContext === serialized) {
        return;
      }
      repoWatch.lastContext = serialized;
      for (const watchId of [...repoWatch.subscribers]) {
        if (this.watchIdRepos.get(watchId) === repoRoot) {
          this.emit({ watchId, context });
        }
      }
    } finally {
      repoWatch.refreshing = false;
      if (repoWatch.refreshAgain) {
        repoWatch.refreshAgain = false;
        this.scheduleRefresh(repoRoot, repoWatch);
      }
    }
  }

  private detach(watchId: string): void {
    const repoRoot = this.watchIdRepos.get(watchId);
    if (!repoRoot) {
      return;
    }
    this.watchIdRepos.delete(watchId);
    const repoWatch = this.repos.get(repoRoot);
    if (!repoWatch) {
      return;
    }
    repoWatch.subscribers.delete(watchId);
    if (repoWatch.subscribers.size === 0) {
      this.repos.delete(repoRoot);
      this.closeRepoWatch(repoWatch);
    }
  }

  private closeRepoWatch(repoWatch: RepoWatch): void {
    if (repoWatch.debounceTimer !== null) {
      clearTimeout(repoWatch.debounceTimer);
      repoWatch.debounceTimer = null;
    }
    if (repoWatch.pollTimer !== null) {
      clearInterval(repoWatch.pollTimer);
      repoWatch.pollTimer = null;
    }
    for (const watcher of repoWatch.fsWatchers) {
      watcher.close();
    }
    repoWatch.fsWatchers.length = 0;
  }

  private emit(event: GitContextChangedEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One renderer/window listener must not starve other subscribers or
        // corrupt watcher registration.
      }
    }
  }
}

/**
 * Facade matching `IpcServices.git`. Each watch id retains only its own window
 * emitter, preventing duplicate fan-out when IPC `watch` is called repeatedly.
 */
export const WSL_POLL_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS;

export function createGitService(options: GitWatchServiceOptions = {}): {
  getContext: typeof getGitContext;
  getDiff: typeof getSessionDiff;
  createWorktree: typeof createSessionWorktree;
  watch(
    input: GitWatchInput,
    emit: GitContextChangedListener,
  ): Promise<{ polling: boolean }>;
  unwatch(watchId: string): Promise<void>;
  dispose(): void;
} {
  const watcher = new GitWatchService(options);
  const emitters = new Map<string, GitContextChangedListener>();
  watcher.onChanged((event) => emitters.get(event.watchId)?.(event));

  return {
    getContext: getGitContext,
    getDiff: getSessionDiff,
    createWorktree: createSessionWorktree,
    async watch(input, emit) {
      validateWatchId(input.watchId);
      emitters.set(input.watchId, emit);
      try {
        await watcher.watch(input);
      } catch (error) {
        emitters.delete(input.watchId);
        throw error;
      }
      return { polling: watcher.isPolling() };
    },
    async unwatch(watchId) {
      emitters.delete(watchId);
      await watcher.unwatch(watchId);
    },
    dispose() {
      emitters.clear();
      watcher.dispose();
    },
  };
}
