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

export class GitWatchService {
  private readonly repos = new Map<string, RepoWatch>();
  private readonly watchIdRepos = new Map<string, string>();
  private readonly listeners = new Set<GitContextChangedListener>();

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

  public subscriberCount(repoRoot: string): number {
    return this.repos.get(repoRoot)?.subscribers.size ?? 0;
  }

  private async createRepoWatch(repoRoot: string): Promise<RepoWatch> {
    const repoWatch: RepoWatch = {
      fsWatchers: [],
      subscribers: new Set(),
      debounceTimer: null,
      refreshing: false,
      refreshAgain: false,
    };

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
export function createGitService(): {
  getContext: typeof getGitContext;
  getDiff: typeof getSessionDiff;
  createWorktree: typeof createSessionWorktree;
  watch(
    input: GitWatchInput,
    emit: GitContextChangedListener,
  ): Promise<void>;
  unwatch(watchId: string): Promise<void>;
  dispose(): void;
} {
  const watcher = new GitWatchService();
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
