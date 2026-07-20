import { createRequire } from "node:module";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SafeStorage } from "electron";

import type {
  AllowedSecretKey,
  SecretBackendStatus,
} from "../types/api";

const require = createRequire(import.meta.url);
const STORE_VERSION = 1;
const STORE_FILE = "secrets.v1.json";
const ALLOWED_KEYS = new Set<AllowedSecretKey>(["openai-api-key"]);

interface PersistedSecrets {
  version: typeof STORE_VERSION;
  values: Partial<Record<AllowedSecretKey, string>>;
}

export interface SecretServiceOptions {
  userDataPath: string;
  safeStorage?: Pick<
    SafeStorage,
    | "isEncryptionAvailable"
    | "encryptString"
    | "decryptString"
    | "getSelectedStorageBackend"
  >;
  platform?: NodeJS.Platform;
  importLegacyOpenAiKey?: () => Promise<string | null> | string | null;
}

function loadSafeStorage(): SecretServiceOptions["safeStorage"] {
  const electron = require("electron") as { safeStorage?: SafeStorage };
  if (!electron.safeStorage) {
    throw new Error("Electron safeStorage is unavailable in this process");
  }
  return electron.safeStorage;
}

function assertAllowedKey(key: string): asserts key is AllowedSecretKey {
  if (!ALLOWED_KEYS.has(key as AllowedSecretKey)) {
    throw new TypeError("Secret key is not allowed");
  }
}

function emptyStore(): PersistedSecrets {
  return { version: STORE_VERSION, values: {} };
}

/** Encrypted, allowlisted secret persistence owned by Electron's main process. */
export class SecretService {
  private readonly storePath: string;
  private readonly platform: NodeJS.Platform;
  private readonly safeStorageOverride?: SecretServiceOptions["safeStorage"];
  private readonly legacyImporter?: SecretServiceOptions["importLegacyOpenAiKey"];
  private operation: Promise<unknown> = Promise.resolve();

  constructor(options: SecretServiceOptions) {
    if (!options?.userDataPath?.trim()) {
      throw new TypeError("userDataPath is required for secret storage");
    }
    this.storePath = path.join(options.userDataPath, STORE_FILE);
    this.platform = options.platform ?? process.platform;
    this.safeStorageOverride = options.safeStorage;
    this.legacyImporter = options.importLegacyOpenAiKey;
  }

  async getBackendStatus(): Promise<SecretBackendStatus> {
    try {
      const storage = this.storage();
      if (this.platform === "linux") {
        const selected = storage.getSelectedStorageBackend();
        if (selected === "basic_text") {
          return {
            available: false,
            encrypted: false,
            backend: "unavailable",
            reason:
              "The Linux secret store is using basic_text; encrypted persistence is disabled.",
          };
        }
      }
      if (!storage.isEncryptionAvailable()) {
        return {
          available: false,
          encrypted: false,
          backend: "unavailable",
          reason: "Operating-system encryption is unavailable.",
        };
      }
      return { available: true, encrypted: true, backend: "safeStorage" };
    } catch {
      return {
        available: false,
        encrypted: false,
        backend: "unavailable",
        reason: "Electron safeStorage is unavailable.",
      };
    }
  }

  async get(key: AllowedSecretKey): Promise<string | null> {
    assertAllowedKey(key);
    return this.enqueue(async () => {
      const storage = await this.requireEncryptedBackend();
      const store = await this.readStore();
      const encoded = store.values[key];
      if (!encoded) return null;
      try {
        return storage.decryptString(Buffer.from(encoded, "base64"));
      } catch {
        throw new Error("Stored secret could not be decrypted");
      }
    });
  }

  async has(key: AllowedSecretKey): Promise<boolean> {
    return Boolean(await this.get(key));
  }

  async set(key: AllowedSecretKey, value: string): Promise<void> {
    assertAllowedKey(key);
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError("Secret value must be a non-empty string");
    }
    await this.enqueue(async () => {
      const storage = await this.requireEncryptedBackend();
      const store = await this.readStore();
      store.values[key] = storage.encryptString(value.trim()).toString("base64");
      await this.writeStore(store);
    });
  }

  async delete(key: AllowedSecretKey): Promise<void> {
    assertAllowedKey(key);
    await this.enqueue(async () => {
      // Deletion remains available if the key store becomes unavailable.
      const store = await this.readStore();
      if (!(key in store.values)) return;
      delete store.values[key];
      await this.writeStore(store);
    });
  }

  /**
   * Runs the explicitly supplied legacy reader and persists its result only
   * through an encrypted backend. Safe to retry; an existing value wins.
   */
  async importLegacyOpenAiKey(): Promise<string | null> {
    const existing = await this.get("openai-api-key").catch(() => null);
    if (existing?.trim()) return existing.trim();
    if (!this.legacyImporter) return null;

    const imported = (await this.legacyImporter())?.trim() ?? "";
    if (!imported) return null;
    await this.set("openai-api-key", imported);
    return imported;
  }

  async flush(): Promise<void> {
    await this.operation;
  }

  private storage(): NonNullable<SecretServiceOptions["safeStorage"]> {
    return this.safeStorageOverride ?? loadSafeStorage()!;
  }

  private async requireEncryptedBackend(): Promise<
    NonNullable<SecretServiceOptions["safeStorage"]>
  > {
    const status = await this.getBackendStatus();
    if (!status.available || !status.encrypted) {
      throw new Error(status.reason ?? "Encrypted secret storage is unavailable");
    }
    return this.storage();
  }

  private async readStore(): Promise<PersistedSecrets> {
    let text: string;
    try {
      text = await readFile(this.storePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
      throw new Error("Secret store could not be read", { cause: error });
    }

    try {
      const parsed = JSON.parse(text) as Partial<PersistedSecrets>;
      if (
        parsed.version !== STORE_VERSION ||
        !parsed.values ||
        typeof parsed.values !== "object" ||
        Array.isArray(parsed.values)
      ) {
        throw new Error("invalid schema");
      }
      const values: PersistedSecrets["values"] = {};
      for (const key of ALLOWED_KEYS) {
        const value = parsed.values[key];
        if (typeof value === "string" && value) values[key] = value;
      }
      return { version: STORE_VERSION, values };
    } catch (error) {
      throw new Error("Secret store is invalid", { cause: error });
    }
  }

  private async writeStore(store: PersistedSecrets): Promise<void> {
    const directory = path.dirname(this.storePath);
    const temporary = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, `${JSON.stringify(store)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.storePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new Error("Secret store could not be written", { cause: error });
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
