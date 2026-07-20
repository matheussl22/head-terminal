import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SecretService } from "../../electron/services/secret-service";

function encryptedStorage(
  backend:
    | "basic_text"
    | "gnome_libsecret"
    | "kwallet"
    | "kwallet5"
    | "kwallet6"
    | "unknown" = "gnome_libsecret",
) {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => backend),
    encryptString: vi.fn((value: string) => Buffer.from(`cipher:${value}`, "utf8")),
    decryptString: vi.fn((value: Buffer) =>
      value.toString("utf8").replace(/^cipher:/, ""),
    ),
  };
}

describe("SecretService", () => {
  let userDataPath: string;

  beforeEach(async () => {
    userDataPath = await mkdtemp(path.join(os.tmpdir(), "head-terminal-secrets-test-"));
  });

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true });
  });

  it("encrypts, atomically persists, reads and deletes the allowlisted key", async () => {
    const safeStorage = encryptedStorage();
    const service = new SecretService({
      userDataPath,
      safeStorage,
      platform: "linux",
    });

    await service.set("openai-api-key", "  sk-private  ");
    expect(await service.get("openai-api-key")).toBe("sk-private");

    const names = await readdir(userDataPath);
    expect(names).toEqual(["secrets.v1.json"]);
    const persisted = await readFile(path.join(userDataPath, names[0]!), "utf8");
    expect(persisted).not.toContain("sk-private");
    expect(persisted).toContain(Buffer.from("cipher:sk-private").toString("base64"));

    await service.delete("openai-api-key");
    expect(await service.get("openai-api-key")).toBeNull();
  });

  it("refuses Linux basic_text without silently writing plaintext", async () => {
    const safeStorage = encryptedStorage("basic_text");
    const service = new SecretService({
      userDataPath,
      safeStorage,
      platform: "linux",
    });

    await expect(service.getBackendStatus()).resolves.toMatchObject({
      available: false,
      encrypted: false,
      backend: "unavailable",
    });
    await expect(service.set("openai-api-key", "sk-nope")).rejects.toThrow(
      "basic_text",
    );
    expect(await readdir(userDataPath)).toEqual([]);
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it("reports unavailable encryption without leaking backend errors", async () => {
    const safeStorage = encryptedStorage();
    safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const service = new SecretService({ userDataPath, safeStorage });

    await expect(service.getBackendStatus()).resolves.toEqual({
      available: false,
      encrypted: false,
      backend: "unavailable",
      reason: "Operating-system encryption is unavailable.",
    });
  });

  it("rejects keys outside the explicit allowlist", async () => {
    const service = new SecretService({
      userDataPath,
      safeStorage: encryptedStorage(),
    });

    await expect(
      service.set("github-token" as "openai-api-key", "secret"),
    ).rejects.toThrow("not allowed");
    await expect(
      service.get("../openai-api-key" as "openai-api-key"),
    ).rejects.toThrow("not allowed");
    expect(await readdir(userDataPath)).toEqual([]);
  });

  it("imports a legacy key once and immediately persists it encrypted", async () => {
    const importer = vi.fn(async () => "  sk-legacy  ");
    const service = new SecretService({
      userDataPath,
      safeStorage: encryptedStorage(),
      importLegacyOpenAiKey: importer,
    });

    await expect(service.importLegacyOpenAiKey()).resolves.toBe("sk-legacy");
    await expect(service.importLegacyOpenAiKey()).resolves.toBe("sk-legacy");
    expect(importer).toHaveBeenCalledTimes(1);
    await expect(service.get("openai-api-key")).resolves.toBe("sk-legacy");
  });

  it("does not migrate a legacy key when encrypted storage is unavailable", async () => {
    const service = new SecretService({
      userDataPath,
      safeStorage: encryptedStorage("basic_text"),
      platform: "linux",
      importLegacyOpenAiKey: () => "sk-legacy",
    });

    await expect(service.importLegacyOpenAiKey()).rejects.toThrow("basic_text");
    expect(await readdir(userDataPath)).toEqual([]);
  });

  it("fails closed on a corrupt store", async () => {
    await writeFile(path.join(userDataPath, "secrets.v1.json"), "{broken", "utf8");
    const service = new SecretService({
      userDataPath,
      safeStorage: encryptedStorage(),
    });

    await expect(service.get("openai-api-key")).rejects.toThrow(
      "Secret store is invalid",
    );
  });
});
