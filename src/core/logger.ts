import { invoke } from "@tauri-apps/api/core";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  ts: string;
  runId: string;
  channel: "dev" | "prod";
  level: LogLevel;
  event: string;
  elapsedMs: number;
  meta?: Record<string, unknown> | object;
}

export interface Checkpoint {
  stage: string;
  ts: string;
  elapsedMs: number;
  meta?: Record<string, unknown> | object;
}

const BOOT_TIME = performance.now();
const LOCAL_STORAGE_KEY = "head-terminal.diag.v2";

let runId = "";
let channel: "dev" | "prod" = import.meta.env.DEV ? "dev" : "prod";
let uiReady = false;
const checkpoints: Checkpoint[] = [];
const recentEvents: LogEvent[] = [];
const MAX_RECENT_EVENTS = 200;

function elapsedMs(): number {
  return Math.round(performance.now() - BOOT_TIME);
}

function nowIso(): string {
  return new Date().toISOString();
}

function persistLocal(line: string): void {
  try {
    const prev = localStorage.getItem(LOCAL_STORAGE_KEY) ?? "";
    const next = `${prev}${line}\n`;
    localStorage.setItem(
      LOCAL_STORAGE_KEY,
      next.length > 32_000 ? next.slice(-32_000) : next,
    );
  } catch {
    /* ignore */
  }
}

function pushEvent(
  level: LogLevel,
  event: string,
  meta?: Record<string, unknown> | object,
): LogEvent {
  const entry: LogEvent = {
    ts: nowIso(),
    runId: runId || "pending",
    channel,
    level,
    event,
    elapsedMs: elapsedMs(),
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  };

  recentEvents.push(entry);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.shift();
  }

  const line = JSON.stringify(entry);
  // eslint-disable-next-line no-console
  console.log(`[head-terminal] ${line}`);
  persistLocal(line);

  void invoke("append_log", { line }).catch(() => {
    void invoke("frontend_log", { message: line }).catch(() => {});
  });

  return entry;
}

export function initLogger(context: {
  runId: string;
  channel?: "dev" | "prod";
}): void {
  runId = context.runId;
  if (context.channel) {
    channel = context.channel;
  }
}

export function getRunId(): string {
  return runId;
}

export function getChannel(): "dev" | "prod" {
  return channel;
}

export function isUiReady(): boolean {
  return uiReady;
}

export function markUiReady(meta?: Record<string, unknown> | object): void {
  if (uiReady) {
    return;
  }
  uiReady = true;
  checkpoint("ui.ready", meta);
}

export function checkpoint(
  stage: string,
  meta?: Record<string, unknown> | object,
): Checkpoint {
  const entry: Checkpoint = {
    stage,
    ts: nowIso(),
    elapsedMs: elapsedMs(),
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  };
  checkpoints.push(entry);
  pushEvent("info", "bootstrap.checkpoint", { stage, ...meta });
  void invoke("append_checkpoint", {
    stage,
    elapsedMs: entry.elapsedMs,
    meta: meta ?? null,
  }).catch(() => {});
  return entry;
}

export function logEvent(
  level: LogLevel,
  event: string,
  meta?: Record<string, unknown> | object,
): void {
  pushEvent(level, event, meta);
}

export function logError(
  event: string,
  error: unknown,
  meta?: Record<string, unknown> | object,
): void {
  const errorMeta: Record<string, unknown> = {
    ...(meta as Record<string, unknown> | undefined),
  };
  if (error instanceof Error) {
    errorMeta.message = error.message;
    errorMeta.stack = error.stack;
  } else {
    errorMeta.message = String(error);
  }
  pushEvent("error", event, errorMeta);
}

export function getCheckpoints(): readonly Checkpoint[] {
  return checkpoints;
}

export function getLastCheckpoint(): Checkpoint | null {
  return checkpoints[checkpoints.length - 1] ?? null;
}

export function getRecentEvents(): readonly LogEvent[] {
  return recentEvents;
}

export function getFrontendDiagnosticBundle(): Record<string, unknown> {
  return {
    runId,
    channel,
    uiReady,
    elapsedMs: elapsedMs(),
    checkpoints: [...checkpoints],
    events: [...recentEvents],
    document: {
      readyState: typeof document !== "undefined" ? document.readyState : null,
      rootChildCount:
        typeof document !== "undefined"
          ? document.getElementById("root")?.childElementCount ?? 0
          : null,
      innerWidth: typeof window !== "undefined" ? window.innerWidth : null,
      innerHeight: typeof window !== "undefined" ? window.innerHeight : null,
    },
  };
}
