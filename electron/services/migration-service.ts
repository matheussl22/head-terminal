import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { PersistedWorkspace } from "../types/api";
import { isPersistedWorkspace, type WorkspaceService } from "./workspace-service";

const WORKSPACE_KEYS = [
  "head-terminal.workspace.v1",
  "head-terminal.workspace.v1.dev",
] as const;

export const LEGACY_PREFERENCE_KEYS = [
  "head-terminal.sidebar.collapsed",
  "head-terminal.run-everything",
  "head-terminal.pane-headers.enabled",
  "head-terminal.font-size",
  "head-terminal.renderer",
  "head-terminal.copy-on-select",
  "head-terminal.recent-cwds",
  "head-terminal.last-agent",
  "head-terminal.last-claude-account",
  "head-terminal.claude-accounts",
  "head-terminal.claude-default-account-name",
] as const;

export interface MigratedPreferences {
  version: 1;
  values: Record<string, string>;
}

export interface MigrationResult {
  status: "imported" | "already-completed" | "not-found" | "invalid";
  workspaceImported: boolean;
  preferenceCount: number;
  source: string;
  preferences: Record<string, string>;
  error?: string;
}

export interface MigrationServiceOptions {
  userDataPath: string;
  workspaceService: Pick<WorkspaceService, "load" | "save">;
  sourcePath?: string;
  channel?: "dev" | "prod";
  now?: () => Date;
  legacyDatabasePaths?: string[];
  readLegacyDatabase?: LegacyDatabaseReader;
}

export type LegacyDatabaseReader = (
  path: string,
) => Promise<Record<string, unknown> | null>;

interface NormalizedPayload {
  workspace: PersistedWorkspace | null;
  workspaceInvalid: boolean;
  preferences: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** WebKitGTK stores localStorage values as UTF-16LE BLOBs in ItemTable. */
export function decodeWebKitStorageValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!(value instanceof Uint8Array)) {
    return null;
  }
  return Buffer.from(value)
    .toString("utf16le")
    .replace(/^\ufeff/u, "")
    .replace(/\0+$/u, "");
}

interface SqliteStatement {
  all(): Array<Record<string, unknown>>;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => SqliteDatabase;
}

export async function readWebKitLocalStorageDatabase(
  path: string,
): Promise<Record<string, unknown> | null> {
  let database: SqliteDatabase | undefined;
  try {
    // Kept variable-based so Node 20 test resolution does not require node:sqlite.
    const sqliteSpecifier = "node:sqlite";
    const sqlite = await import(sqliteSpecifier) as unknown as SqliteModule;
    database = new sqlite.DatabaseSync(path, { readOnly: true });
    const rows = database.prepare("SELECT key, value FROM ItemTable").all();
    const values: Record<string, unknown> = {};
    for (const row of rows) {
      if (typeof row.key !== "string") {
        continue;
      }
      const decoded = decodeWebKitStorageValue(row.value);
      if (decoded !== null) {
        values[row.key] = decoded;
      }
    }
    return values;
  } catch {
    return null;
  } finally {
    try {
      database?.close();
    } catch {
      // Legacy migration is best-effort and must never prevent application boot.
    }
  }
}

function storageRecord(payload: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["localStorage", "storage", "values", "data"] as const) {
    if (isRecord(payload[key])) {
      return payload[key];
    }
  }
  return payload;
}

export function normalizeMigrationPayload(
  payload: unknown,
  channel: "dev" | "prod" = "prod",
): NormalizedPayload | null {
  if (!isRecord(payload) || (payload.version !== undefined && payload.version !== 1)) {
    return null;
  }
  const storage = storageRecord(payload);
  const preferredWorkspaceKey = channel === "dev" ? WORKSPACE_KEYS[1] : WORKSPACE_KEYS[0];
  const rawWorkspace = payload.workspace
    ?? storage[preferredWorkspaceKey]
    ?? storage[WORKSPACE_KEYS[0]]
    ?? storage[WORKSPACE_KEYS[1]];
  const workspaceCandidate = parseMaybeJson(rawWorkspace);
  const workspace = isPersistedWorkspace(workspaceCandidate) ? workspaceCandidate : null;

  const explicitPreferences = isRecord(payload.preferences)
    ? payload.preferences
    : storage;
  const preferences: Record<string, string> = {};
  for (const key of LEGACY_PREFERENCE_KEYS) {
    const value = explicitPreferences[key];
    if (typeof value === "string") {
      preferences[key] = value;
    } else if (value !== undefined) {
      preferences[key] = JSON.stringify(value);
    }
  }
  // The old plaintext OpenAI key is deliberately excluded. Secret migration
  // belongs to SecretService, which can enforce safeStorage availability.
  return {
    workspace,
    workspaceInvalid: rawWorkspace !== undefined
      && rawWorkspace !== null
      && workspace === null,
    preferences,
  };
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export function defaultMigrationSourcePath(): string {
  return process.platform === "linux"
    ? join(homedir(), ".local", "share", "head-terminal", "migration-v1.json")
    : join(homedir(), ".head-terminal", "migration-v1.json");
}

export function defaultLegacyDatabasePaths(channel: "dev" | "prod" = "prod"): string[] {
  const dataRoot = process.platform === "linux"
    ? join(homedir(), ".local", "share")
    : join(homedir(), "Library", "Application Support");
  const prod = join(
    dataRoot,
    "com.matheus.head-terminal",
    "localstorage",
    "tauri_localhost_0.localstorage",
  );
  const dev = join(
    dataRoot,
    "com.matheus.head-terminal.dev",
    "localstorage",
    "tauri_localhost_0.localstorage",
  );
  return channel === "dev" ? [dev, prod] : [prod, dev];
}

export class MigrationService {
  readonly sourcePath: string;
  readonly preferencesPath: string;
  readonly markerPath: string;
  readonly #workspaceService: Pick<WorkspaceService, "load" | "save">;
  readonly #channel: "dev" | "prod";
  readonly #now: () => Date;
  readonly #legacyDatabasePaths: string[];
  readonly #readLegacyDatabase: LegacyDatabaseReader;

  constructor(options: MigrationServiceOptions) {
    this.sourcePath = options.sourcePath ?? defaultMigrationSourcePath();
    this.preferencesPath = join(options.userDataPath, "preferences.v1.json");
    this.markerPath = join(options.userDataPath, "migration-complete.json");
    this.#workspaceService = options.workspaceService;
    this.#channel = options.channel ?? "prod";
    this.#now = options.now ?? (() => new Date());
    this.#legacyDatabasePaths = options.legacyDatabasePaths
      ?? defaultLegacyDatabasePaths(this.#channel);
    this.#readLegacyDatabase = options.readLegacyDatabase
      ?? readWebKitLocalStorageDatabase;
  }

  async importIfAvailable(): Promise<MigrationResult> {
    if (await this.#hasMarker()) {
      return this.#result("already-completed", false, 0, this.sourcePath, {});
    }
    let raw: string | null = null;
    try {
      raw = await readFile(this.sourcePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (raw !== null) {
      try {
        const result = await this.importPayload(JSON.parse(raw) as unknown, this.sourcePath);
        if (result.status !== "invalid") {
          return result;
        }
      } catch {
        // A corrupt optional export does not prevent read-only DB recovery.
      }
    }

    for (const databasePath of this.#legacyDatabasePaths) {
      const values = await this.#readLegacyDatabase(databasePath);
      if (!values) {
        continue;
      }
      const result = await this.importPayload({ version: 1, localStorage: values }, databasePath);
      if (result.status !== "invalid") {
        return result;
      }
    }

    return this.#result(
      raw === null ? "not-found" : "invalid",
      false,
      0,
      this.sourcePath,
      {},
      raw === null ? undefined : "Payload de migração inválido",
    );
  }

  async importPayload(payload: unknown, source = "payload"): Promise<MigrationResult> {
    if (await this.#hasMarker()) {
      return this.#result("already-completed", false, 0, source, {});
    }
    const normalized = normalizeMigrationPayload(payload, this.#channel);
    if (
      !normalized
      || normalized.workspaceInvalid
      || (!normalized.workspace && Object.keys(normalized.preferences).length === 0)
    ) {
      return this.#result("invalid", false, 0, source, {}, "Payload de migração inválido");
    }

    let workspaceImported = false;
    if (normalized.workspace && !(await this.#workspaceService.load())) {
      await this.#workspaceService.save(normalized.workspace);
      workspaceImported = true;
    }

    const existingPreferences = await this.#loadPreferences();
    // Existing Electron preferences win, so migration cannot roll back choices
    // made before the legacy payload was discovered.
    const preferences = { ...normalized.preferences, ...existingPreferences };
    if (Object.keys(preferences).length > 0) {
      await atomicWrite(this.preferencesPath, { version: 1, values: preferences });
    }
    await atomicWrite(this.markerPath, {
      version: 1,
      source,
      destination: dirname(this.markerPath),
      completedAt: this.#now().toISOString(),
      workspaceImported,
      preferenceCount: Object.keys(normalized.preferences).length,
    });
    return this.#result(
      "imported",
      workspaceImported,
      Object.keys(normalized.preferences).length,
      source,
      preferences,
    );
  }

  async loadMigratedPreferences(): Promise<Record<string, string>> {
    return this.#loadPreferences();
  }

  async #loadPreferences(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.preferencesPath, "utf8"));
      if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.values)) {
        return {};
      }
      return Object.fromEntries(
        Object.entries(parsed.values).filter((entry): entry is [string, string] =>
          LEGACY_PREFERENCE_KEYS.includes(entry[0] as typeof LEGACY_PREFERENCE_KEYS[number])
          && typeof entry[1] === "string"),
      );
    } catch {
      return {};
    }
  }

  async #hasMarker(): Promise<boolean> {
    try {
      const marker: unknown = JSON.parse(await readFile(this.markerPath, "utf8"));
      return isRecord(marker)
        && marker.version === 1
        && typeof marker.source === "string"
        && marker.source.length > 0
        && typeof marker.destination === "string"
        && marker.destination.length > 0
        && typeof marker.completedAt === "string"
        && Number.isFinite(Date.parse(marker.completedAt))
        && typeof marker.workspaceImported === "boolean"
        && Number.isInteger(marker.preferenceCount)
        && (marker.preferenceCount as number) >= 0;
    } catch {
      return false;
    }
  }

  #result(
    status: MigrationResult["status"],
    workspaceImported: boolean,
    preferenceCount: number,
    source: string,
    preferences: Record<string, string>,
    error?: string,
  ): MigrationResult {
    return { status, workspaceImported, preferenceCount, source, preferences, ...(error ? { error } : {}) };
  }
}
