import { logEvent } from "./logger";
import { loadOpenAiApiKey, saveOpenAiApiKey } from "./ui-preferences";

export const OPENAI_SECRET_KEY = "openai-api-key";

/** Returns presence only; secret material never crosses into the renderer. */
export async function hasOpenAiApiKey(): Promise<boolean> {
  try {
    if (await window.headTerminal.secrets.has(OPENAI_SECRET_KEY)) {
      saveOpenAiApiKey("");
      return true;
    }

    // One-time Chromium/localStorage compatibility path. The Tauri WebKit
    // database is imported in the main process; this only handles old beta
    // Electron profiles that may already contain the legacy key.
    const legacy = loadOpenAiApiKey().trim();
    if (legacy) {
      await window.headTerminal.secrets.set(OPENAI_SECRET_KEY, legacy);
      saveOpenAiApiKey("");
      return true;
    }
  } catch (error) {
    logEvent("warn", "voice.api_key.status_error", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return false;
}

export async function persistOpenAiApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();

  if (!trimmed) {
    await window.headTerminal.secrets.delete(OPENAI_SECRET_KEY);
    saveOpenAiApiKey("");
    logEvent("info", "voice.api_key.cleared", {});
    return;
  }

  await window.headTerminal.secrets.set(OPENAI_SECRET_KEY, trimmed);
  saveOpenAiApiKey("");
  logEvent("info", "voice.api_key.saved", { keyLength: trimmed.length });
}
