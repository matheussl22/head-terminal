import { randomUUID } from "node:crypto";

import type {
  RemoteCommand,
  RemoteCommandReply,
  RemoteCommandRequest,
  RemoteCommandResult,
  RemoteScreen,
  RemoteSnapshot,
} from "../../src/types/remote";

/**
 * Main's half of the phone remote: the renderer owns the sessions and the
 * terminals, the server owns the phones, and this keeps the last word the
 * renderer said about each (the list, every watched pane's screen) and
 * carries commands across with a reply. It is the server's `RemoteHost`.
 */

/** A command the renderer never answers (reloading, wedged) fails, it does
 * not hang the phone's request. */
const COMMAND_TIMEOUT_MS = 15_000;

export interface RemoteRenderer {
  /** Sends `remote:command` / `remote:watch` to the window; false when there
   * is no window to send to. */
  sendCommand(request: RemoteCommandRequest): boolean;
  sendWatch(paneIds: string[]): void;
}

type Listener<T> = (value: T) => void;

export class RemoteBridge {
  private snapshot: RemoteSnapshot | null = null;
  private readonly screens = new Map<string, RemoteScreen>();
  private readonly snapshotListeners = new Set<Listener<RemoteSnapshot>>();
  private readonly screenListeners = new Set<Listener<RemoteScreen>>();
  private readonly pending = new Map<
    string,
    { resolve: (result: RemoteCommandResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private watched: string[] = [];
  private renderer: RemoteRenderer | null = null;

  constructor(
    private readonly transcribeAudio: (bytes: Uint8Array, mimeType: string) => Promise<string>,
    /** Read when needed: the language can change while the app runs. */
    private readonly unavailableMessage: () => string = () => "Head Terminal window is not open",
  ) {}

  /** The window that answers; null while there is none (macOS, closed). */
  attachRenderer(renderer: RemoteRenderer | null): void {
    this.renderer = renderer;
    if (!renderer) {
      for (const [requestId, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.resolve({ ok: false, error: this.unavailableMessage() });
        this.pending.delete(requestId);
      }
      return;
    }
    // A reloaded window starts without knowing what phones look at.
    renderer.sendWatch(this.watched);
  }

  // Renderer → main.

  publishState(snapshot: RemoteSnapshot): void {
    this.snapshot = snapshot;
    // A pane that is gone has no screen to keep.
    const panes = new Set(snapshot.sessions.flatMap((session) => session.panes.map((pane) => pane.paneId)));
    for (const paneId of this.screens.keys()) {
      if (!panes.has(paneId)) this.screens.delete(paneId);
    }
    for (const listener of this.snapshotListeners) listener(snapshot);
  }

  publishScreen(screen: RemoteScreen): void {
    this.screens.set(screen.paneId, screen);
    for (const listener of this.screenListeners) listener(screen);
  }

  replyCommand(reply: RemoteCommandReply): void {
    const entry = this.pending.get(reply.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(reply.requestId);
    entry.resolve(reply.result);
  }

  // RemoteHost (the server's side).

  getSnapshot(): RemoteSnapshot | null {
    return this.snapshot;
  }

  onSnapshot(listener: Listener<RemoteSnapshot>): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  getScreen(paneId: string): RemoteScreen | null {
    return this.screens.get(paneId) ?? null;
  }

  onScreen(listener: Listener<RemoteScreen>): () => void {
    this.screenListeners.add(listener);
    return () => this.screenListeners.delete(listener);
  }

  watchedPanes(): string[] {
    return [...this.watched];
  }

  setWatchedPanes(paneIds: readonly string[]): void {
    this.watched = [...new Set(paneIds)].sort();
    this.renderer?.sendWatch(this.watched);
  }

  runCommand(command: RemoteCommand): Promise<RemoteCommandResult> {
    const renderer = this.renderer;
    if (!renderer) {
      return Promise.resolve({ ok: false, error: this.unavailableMessage() });
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: this.unavailableMessage() });
      }, COMMAND_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, { resolve, timer });
      if (!renderer.sendCommand({ requestId, command })) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ ok: false, error: this.unavailableMessage() });
      }
    });
  }

  transcribe(bytes: Uint8Array, mimeType: string): Promise<string> {
    return this.transcribeAudio(bytes, mimeType);
  }
}
