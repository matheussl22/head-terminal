/**
 * Contract of the phone remote: what the renderer publishes about its
 * sessions, what a phone may ask of a pane, and what the main process relays
 * between the two. The renderer owns the state (the store, the xterm
 * buffers); main only serves it over the LAN (see
 * electron/services/remote/remote-server.ts).
 */

import type { BlockedReason, PaneActivity } from "./activity";

/** A pane as the phone lists it. */
export interface RemotePaneSummary {
  paneId: string;
  /** 1-based position in its session, as the desktop numbers it. */
  index: number;
  /** The conversation's name when known, else the agent's. */
  title: string;
  /** Agent profile id (claude, codex, cursor, shell…). */
  agentProfileId: string;
  activity: PaneActivity;
  blockedReason?: BlockedReason;
  /** Tool of a permission request ("Bash"), or what the agent asked. */
  blockedDetail?: string;
  /** Finished a turn nobody has looked at yet. */
  done: boolean;
  /** When `activity` last changed, epoch ms. */
  activitySince: number;
  /** Remaining context, 0-100, when the agent reports it. */
  contextPercent?: number;
}

/**
 * - live: its terminals are running.
 * - hibernated: idle long enough that its processes were stopped; waking it
 *   resumes each pane's conversation.
 * - not_started: never opened since the app started (spawn is lazy).
 */
export type RemoteSessionState = "live" | "hibernated" | "not_started";

export interface RemoteSessionSummary {
  sessionId: string;
  title: string;
  cwd: string;
  agentProfileId: string;
  /** Human name of the agent profile ("Claude Code"). */
  agentLabel: string;
  /** The session on the desktop's screen. */
  active: boolean;
  pinned: boolean;
  state: RemoteSessionState;
  /** Epoch ms the session was hibernated, while it is. */
  hibernatedAt?: number;
  panes: RemotePaneSummary[];
}

export interface RemoteSnapshot {
  sessions: RemoteSessionSummary[];
  /** Epoch ms. */
  updatedAt: number;
}

/** One styled stretch of a screen line: [text, index into `styles`]. */
export type RemoteRun = [text: string, style: number];

/**
 * The tail of a pane's terminal, already resolved to colors so the phone
 * needs no terminal emulator. Plain JSON: one per update, never a diff.
 */
export interface RemoteScreen {
  paneId: string;
  cols: number;
  rows: number;
  /** Oldest first. Trailing blanks trimmed. */
  lines: RemoteRun[][];
  /** CSS declarations per style index; index 0 is always "" (default). */
  styles: string[];
  /** Cursor position relative to `lines`, when it is inside them. */
  cursor?: { line: number; col: number };
  theme: { background: string; foreground: string };
  /** Epoch ms. */
  at: number;
}

/** Keys a phone can press that a text field cannot type. */
export const REMOTE_KEYS = [
  "enter",
  "escape",
  "tab",
  "shift-tab",
  "up",
  "down",
  "left",
  "right",
  "backspace",
  "ctrl-c",
  "ctrl-d",
  "1",
  "2",
  "3",
  "4",
  "y",
  "n",
] as const;

export type RemoteKey = (typeof REMOTE_KEYS)[number];

export type RemoteCommand =
  /** Paste `text` into the pane; `submit` presses Enter after it. */
  | { type: "send-text"; paneId: string; text: string; submit: boolean }
  | { type: "send-key"; paneId: string; key: RemoteKey }
  /** Start a hibernated (or never opened) session in the background. */
  | { type: "wake-session"; sessionId: string }
  /** Stop an idle session's processes now. */
  | { type: "hibernate-session"; sessionId: string }
  /** Bring the session (and pane) up on the desktop. */
  | { type: "focus-session"; sessionId: string; paneId?: string };

export type RemoteCommandResult = { ok: true } | { ok: false; error: string };

/** Main → renderer: run a phone's command and answer with `requestId`. */
export interface RemoteCommandRequest {
  requestId: string;
  command: RemoteCommand;
}

export interface RemoteCommandReply {
  requestId: string;
  result: RemoteCommandResult;
}

/** What Settings shows about the remote. */
export interface RemoteStatus {
  enabled: boolean;
  running: boolean;
  port: number | null;
  /** https://<lan-ip>:<port>/ for every LAN address, best guess first. */
  urls: string[];
  /** Six digits a new phone types to pair. Null while not running. */
  pin: string | null;
  devices: RemoteDevice[];
  /** Why it is not running, when it should be. */
  error?: string;
}

export interface RemoteDevice {
  id: string;
  name: string;
  pairedAt: number;
  lastSeenAt: number;
}
