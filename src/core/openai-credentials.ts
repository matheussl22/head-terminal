import { invoke } from "@tauri-apps/api/core";

import { logEvent } from "./logger";
import { loadOpenAiApiKey, saveOpenAiApiKey } from "./ui-preferences";

export const OPENAI_SECRET_KEY = "openai-api-key";

let cachedKey: string | null = null;

export function invalidateOpenAiApiKeyCache(): void {
  cachedKey = null;
}

export async function resolveOpenAiApiKey(): Promise<string> {
  if (cachedKey) {
    logEvent("debug", "voice.api_key.cache_hit", {
      keyLength: cachedKey.length,
    });
    return cachedKey;
  }

  try {
    const stored = await invoke<string | null>("secret_get", {
      key: OPENAI_SECRET_KEY,
    });
    if (stored?.trim()) {
      cachedKey = stored.trim();
      saveOpenAiApiKey(cachedKey);
      logEvent("info", "voice.api_key.resolved", {
        source: "keyring",
        keyLength: cachedKey.length,
      });
      return cachedKey;
    }
    logEvent("debug", "voice.api_key.keyring_empty", {});
  } catch (error) {
    logEvent("warn", "voice.api_key.keyring_error", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const legacy = loadOpenAiApiKey().trim();
  if (legacy) {
    try {
      await invoke("secret_set", { key: OPENAI_SECRET_KEY, value: legacy });
    } catch {
      // keep using legacy until keyring works
    }
    cachedKey = legacy;
    logEvent("info", "voice.api_key.resolved", {
      source: "localStorage",
      keyLength: legacy.length,
    });
    return legacy;
  }
  logEvent("debug", "voice.api_key.local_empty", {});

  try {
    const imported = await invoke<string | null>("legacy_openai_api_key");
    if (imported?.trim()) {
      const key = imported.trim();
      saveOpenAiApiKey(key);
      try {
        await invoke("secret_set", { key: OPENAI_SECRET_KEY, value: key });
      } catch (error) {
        logEvent("warn", "voice.api_key.import_keyring_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      cachedKey = key;
      logEvent("info", "voice.api_key.resolved", {
        source: "sibling_profile",
        keyLength: key.length,
      });
      return key;
    }
    logEvent("debug", "voice.api_key.sibling_empty", {});
  } catch (error) {
    logEvent("error", "voice.api_key.sibling_error", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  logEvent("warn", "voice.api_key.missing", {});
  return "";
}

export async function persistOpenAiApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  invalidateOpenAiApiKeyCache();

  saveOpenAiApiKey(trimmed);

  if (!trimmed) {
    try {
      await invoke("secret_delete", { key: OPENAI_SECRET_KEY });
    } catch {
      // ignore
    }
    logEvent("info", "voice.api_key.cleared", {});
    return;
  }

  await invoke("secret_set", { key: OPENAI_SECRET_KEY, value: trimmed });
  cachedKey = trimmed;
  logEvent("info", "voice.api_key.saved", { keyLength: trimmed.length });
}
