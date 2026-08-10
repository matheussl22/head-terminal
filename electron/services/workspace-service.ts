import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { PersistedWorkspace } from "../types/api";

export interface WorkspaceServiceOptions {
  userDataPath: string;
  channel?: "dev" | "prod";
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isLayoutNode(value: unknown, depth = 0): boolean {
  if (!isRecord(value) || depth > 16) return false;
  if (value.kind === "pane") {
    return isBoundedString(value.paneId, 256);
  }
  if (value.kind !== "split") return false;
  return (value.direction === "horizontal" || value.direction === "vertical")
    && typeof value.ratio === "number"
    && Number.isFinite(value.ratio)
    && value.ratio > 0
    && value.ratio < 1
    && isLayoutNode(value.first, depth + 1)
    && isLayoutNode(value.second, depth + 1);
}

export function isPersistedWorkspace(value: unknown): value is PersistedWorkspace {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions)) {
    return false;
  }
  if (value.activeSessionId !== null && typeof value.activeSessionId !== "string") {
    return false;
  }
  if (value.activePaneId !== null && typeof value.activePaneId !== "string") {
    return false;
  }
  if (value.sessions.length > 500) return false;
  if (!isPaneResumeSessionIds(value.paneResumeSessionIds)) return false;
  if (!isConversationLabels(value.conversationLabels)) return false;
  return value.sessions.every((session) =>
    isRecord(session)
    && isBoundedString(session.id, 256)
    && isBoundedString(session.title, 256)
    && isBoundedString(session.cwd, 16_384)
    && isBoundedString(session.agentProfileId, 128)
    && (session.claudeAccountId === undefined
      || isBoundedString(session.claudeAccountId, 256))
    && (session.pinned === undefined || typeof session.pinned === "boolean")
    && isLayoutNode(session.layout));
}

function isPaneResumeSessionIds(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 2_000) return false;
  return entries.every(
    ([paneId, sessionId]) =>
      isBoundedString(paneId, 256) && isBoundedString(sessionId, 256),
  );
}

/** CLI session id -> user-chosen conversation name. The renderer caps both
 * the entry count and the name length well below these bounds; they exist so
 * a hand-edited workspace file can't grow without limit. */
function isConversationLabels(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 1_000) return false;
  return entries.every(
    ([cliSessionId, label]) =>
      isBoundedString(cliSessionId, 256) && isBoundedString(label, 256),
  );
}

export class WorkspaceService {
  readonly workspacePath: string;
  readonly #now: () => Date;
  #saveQueue: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceServiceOptions) {
    this.workspacePath = join(
      options.userDataPath,
      options.channel === "dev" ? "workspace.v1.dev.json" : "workspace.v1.json",
    );
    this.#now = options.now ?? (() => new Date());
  }

  async load(): Promise<PersistedWorkspace | null> {
    let raw: string;
    try {
      raw = await readFile(this.workspacePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isPersistedWorkspace(parsed)) {
        throw new Error("Schema de workspace inválido");
      }
      return parsed;
    } catch {
      const timestamp = this.#now().toISOString().replaceAll(/[:.]/gu, "-");
      const corruptPath = join(
        dirname(this.workspacePath),
        `${basename(this.workspacePath)}.corrupt-${timestamp}`,
      );
      await rename(this.workspacePath, corruptPath);
      return null;
    }
  }

  async save(workspace: PersistedWorkspace): Promise<void> {
    if (!isPersistedWorkspace(workspace)) {
      throw new Error("Workspace inválido");
    }
    const snapshot = JSON.stringify(workspace, null, 2);
    const operation = this.#saveQueue.then(async () => {
      const directory = dirname(this.workspacePath);
      await mkdir(directory, { recursive: true });
      const temporaryPath = join(directory, `.${basename(this.workspacePath)}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, this.workspacePath);
      } catch (error) {
        // A leftover temporary file is harmless and never considered on load.
        throw error;
      }
    });
    this.#saveQueue = operation.catch(() => undefined);
    await operation;
  }

  async flush(): Promise<void> {
    await this.#saveQueue;
  }
}
