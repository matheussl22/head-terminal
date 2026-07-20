import {
  fetchGitContext,
  startGitWatch,
  stopGitWatch,
  subscribeGitContextChanges,
} from "./git-watch-bridge";
import type { GitContext } from "../types/git-context";

// The fs watcher (start_git_watch) only observes .git/HEAD and .git/index,
// so it catches commits/checkouts but not arbitrary working-tree edits that
// flip the "dirty" flag. The poll is the fallback that catches those.
const FOCUSED_POLL_MS = 8000;
const UNFOCUSED_POLL_MS = 30000;

type Subscriber = (context: GitContext) => void;

interface Entry {
  cwd: string;
  watchId: string;
  subscribers: Set<Subscriber>;
  timer: ReturnType<typeof setInterval> | null;
  lastContext: GitContext | null;
}

const entries = new Map<string, Entry>();
const entriesByWatchId = new Map<string, Entry>();
let watchSeq = 0;
let globalListenerStarted = false;
let visibilityHooked = false;

function notify(entry: Entry, context: GitContext): void {
  entry.lastContext = context;
  for (const subscriber of entry.subscribers) {
    subscriber(context);
  }
}

function pollOnce(entry: Entry): void {
  void fetchGitContext(entry.cwd)
    .then((context) => {
      if (entries.get(entry.cwd) === entry) {
        notify(entry, { ...context, source: "poll" });
      }
    })
    .catch(() => undefined);
}

function schedulePoll(entry: Entry): void {
  if (entry.timer !== null) {
    clearInterval(entry.timer);
    entry.timer = null;
  }

  if (typeof document !== "undefined" && document.hidden) {
    return;
  }

  const interval =
    typeof document !== "undefined" && document.hasFocus()
      ? FOCUSED_POLL_MS
      : UNFOCUSED_POLL_MS;
  entry.timer = setInterval(() => pollOnce(entry), interval);
}

function rescheduleAllPolls(): void {
  for (const entry of entries.values()) {
    schedulePoll(entry);
  }
}

function ensureVisibilityHooks(): void {
  if (visibilityHooked || typeof document === "undefined") {
    return;
  }
  visibilityHooked = true;
  document.addEventListener("visibilitychange", rescheduleAllPolls);
  window.addEventListener("focus", rescheduleAllPolls);
  window.addEventListener("blur", rescheduleAllPolls);
}

function ensureGlobalListener(): void {
  if (globalListenerStarted) {
    return;
  }
  globalListenerStarted = true;

  void subscribeGitContextChanges((watchId, context) => {
    const entry = entriesByWatchId.get(watchId);
    if (entry) {
      notify(entry, context);
    }
  }).catch(() => {
    // Fora do Tauri (ex.: testes) — sem watcher, o poll cobre.
    globalListenerStarted = false;
  });
}

/**
 * Subscribe to git context for a directory. Watches and polls are shared
 * per cwd (refcounted); the returned function releases the subscription.
 */
export function acquireGitContext(
  cwd: string,
  subscriber: Subscriber,
): () => void {
  const normalized = cwd.trim();
  if (!normalized) {
    return () => undefined;
  }

  ensureVisibilityHooks();
  ensureGlobalListener();

  let entry = entries.get(normalized);
  if (!entry) {
    const created: Entry = {
      cwd: normalized,
      watchId: `git-registry:${watchSeq++}`,
      subscribers: new Set(),
      timer: null,
      lastContext: null,
    };
    entry = created;
    entries.set(normalized, created);
    entriesByWatchId.set(created.watchId, created);

    void fetchGitContext(normalized)
      .then((context) => {
        if (entries.get(normalized) === created) {
          notify(created, context);
        }
      })
      .catch(() => undefined);

    void startGitWatch(created.watchId, normalized).catch(() => undefined);
    schedulePoll(created);
  } else if (entry.lastContext) {
    subscriber(entry.lastContext);
  }

  const active = entry;
  active.subscribers.add(subscriber);

  return () => {
    active.subscribers.delete(subscriber);
    if (active.subscribers.size > 0) {
      return;
    }

    entries.delete(active.cwd);
    entriesByWatchId.delete(active.watchId);
    if (active.timer !== null) {
      clearInterval(active.timer);
      active.timer = null;
    }
    void stopGitWatch(active.watchId).catch(() => undefined);
  };
}
