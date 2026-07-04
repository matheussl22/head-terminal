import { create } from "zustand";

import { logEvent } from "./logger";
import { useSessionStore } from "./session-manager";

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const MAX_ATTEMPTS = 5;
const HEALTHY_RESET_MS = 60000;

export type SupervisorPaneState =
  | { kind: "healthy" }
  | { kind: "countdown"; attempt: number; deadline: number }
  | { kind: "failed"; attempt: number }
  | { kind: "user_stopped" };

export interface SupervisorCallbacks {
  restart: (paneId: string) => void;
  onStateChange?: (paneId: string, state: SupervisorPaneState | null) => void;
  now?: () => number;
}

interface PaneRecord {
  state: SupervisorPaneState;
  attempts: number;
  spawnedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class PaneSupervisor {
  private panes = new Map<string, PaneRecord>();
  private readonly now: () => number;

  constructor(private readonly callbacks: SupervisorCallbacks) {
    this.now = callbacks.now ?? Date.now;
  }

  getState(paneId: string): SupervisorPaneState | null {
    return this.panes.get(paneId)?.state ?? null;
  }

  /** Pane spawned (or respawned) successfully. */
  noteSpawned(paneId: string): void {
    const record = this.ensure(paneId);
    this.clearTimer(record);
    record.spawnedAt = this.now();
    this.transition(paneId, record, { kind: "healthy" });
  }

  /** PTY died while mounted. Schedules a respawn with backoff. */
  noteExit(paneId: string): void {
    const record = this.ensure(paneId);
    this.clearTimer(record);

    if (record.state.kind === "user_stopped") {
      return;
    }

    if (this.now() - record.spawnedAt >= HEALTHY_RESET_MS) {
      record.attempts = 0;
    }

    if (record.attempts >= MAX_ATTEMPTS) {
      this.transition(paneId, record, {
        kind: "failed",
        attempt: record.attempts,
      });
      return;
    }

    const delay = BACKOFF_MS[Math.min(record.attempts, BACKOFF_MS.length - 1)];
    record.attempts += 1;
    this.transition(paneId, record, {
      kind: "countdown",
      attempt: record.attempts,
      deadline: this.now() + delay,
    });

    record.timer = setTimeout(() => {
      record.timer = null;
      this.fireRestart(paneId, record);
    }, delay);
  }

  /** "Agora" button — restart without waiting for the countdown. */
  restartNow(paneId: string): void {
    const record = this.ensure(paneId);
    this.clearTimer(record);
    if (record.state.kind === "failed" || record.state.kind === "user_stopped") {
      record.attempts = 0;
    }
    this.fireRestart(paneId, record);
  }

  /** "Cancelar" button — stop respawning until the user restarts manually. */
  cancel(paneId: string): void {
    const record = this.ensure(paneId);
    this.clearTimer(record);
    this.transition(paneId, record, { kind: "user_stopped" });
  }

  /** Pane left the layout; drop all supervisor state. */
  forget(paneId: string): void {
    const record = this.panes.get(paneId);
    if (!record) {
      return;
    }
    this.clearTimer(record);
    this.panes.delete(paneId);
    this.callbacks.onStateChange?.(paneId, null);
  }

  private fireRestart(paneId: string, record: PaneRecord): void {
    logEvent("info", "supervisor.restart", {
      paneId,
      attempt: record.attempts,
    });
    this.callbacks.restart(paneId);
  }

  private ensure(paneId: string): PaneRecord {
    let record = this.panes.get(paneId);
    if (!record) {
      record = {
        state: { kind: "healthy" },
        attempts: 0,
        spawnedAt: this.now(),
        timer: null,
      };
      this.panes.set(paneId, record);
    }
    return record;
  }

  private transition(
    paneId: string,
    record: PaneRecord,
    state: SupervisorPaneState,
  ): void {
    record.state = state;
    this.callbacks.onStateChange?.(paneId, state);
  }

  private clearTimer(record: PaneRecord): void {
    if (record.timer !== null) {
      clearTimeout(record.timer);
      record.timer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton wired to the session store (UI reads state via useSupervisorStore).

interface SupervisorStore {
  states: Record<string, SupervisorPaneState>;
}

export const useSupervisorStore = create<SupervisorStore>(() => ({
  states: {},
}));

export const paneSupervisor = new PaneSupervisor({
  restart: (paneId) => useSessionStore.getState().restartPane(paneId),
  onStateChange: (paneId, state) => {
    useSupervisorStore.setState((current) => {
      const states = { ...current.states };
      if (state === null) {
        delete states[paneId];
      } else {
        states[paneId] = state;
      }
      return { states };
    });
  },
});
