import { sendTextToPane } from "../actions/sendAgentCommand";
import { logEvent } from "./logger";
import { useSessionStore } from "./session-manager";
import { resolveOpenAiApiKey } from "./openai-credentials";
import { startVoiceRecording, stopAndTranscribeVoice } from "./voice-bridge";

let audioCtx: AudioContext | null = null;

function beep(freq: number): void {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.09);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
  } catch {
    // audio unavailable — voice recording itself doesn't depend on this
  }
}

export function isVoiceInputBlocked(paneId: string): boolean {
  const { voiceRecordingPaneId, voiceTranscribingPaneId } =
    useSessionStore.getState();

  if (voiceTranscribingPaneId !== null) {
    return true;
  }

  if (voiceRecordingPaneId !== null && voiceRecordingPaneId !== paneId) {
    return true;
  }

  return false;
}

export async function toggleVoiceInput(
  paneId: string,
  options?: { onError?: () => void },
): Promise<void> {
  if (isVoiceInputBlocked(paneId)) {
    logEvent("debug", "voice.toggle_blocked", { paneId });
    return;
  }

  const {
    voiceRecordingPaneId,
    setVoiceRecordingPaneId,
    setVoiceTranscribingPaneId,
  } = useSessionStore.getState();

  if (voiceRecordingPaneId !== paneId) {
    logEvent("info", "voice.recording_start", { paneId });
    try {
      setVoiceRecordingPaneId(paneId);
      await startVoiceRecording();
      beep(880);
      logEvent("info", "voice.recording_started", { paneId });
    } catch (error) {
      setVoiceRecordingPaneId(null);
      const message = error instanceof Error ? error.message : String(error);
      logEvent("error", "voice.start_failed", { paneId, message });
      options?.onError?.();
    }
    return;
  }

  setVoiceRecordingPaneId(null);
  setVoiceTranscribingPaneId(paneId);
  beep(440);
  logEvent("info", "voice.transcribe_begin", { paneId });

  try {
    const apiKey = await resolveOpenAiApiKey();
    if (!apiKey) {
      logEvent("error", "voice.transcribe_failed", {
        paneId,
        message: "Configure sua chave da OpenAI nas Configurações.",
      });
      options?.onError?.();
      return;
    }

    const text = await stopAndTranscribeVoice(apiKey);
    if (text) {
      logEvent("info", "voice.transcribe_ok", {
        paneId,
        textLength: text.length,
      });
      sendTextToPane(paneId, text);
    } else {
      logEvent("info", "voice.empty_transcript", { paneId });
      options?.onError?.();
    }
  } catch (error) {
    logEvent("error", "voice.transcribe_failed", {
      paneId,
      message: error instanceof Error ? error.message : String(error),
    });
    options?.onError?.();
  } finally {
    setVoiceTranscribingPaneId(null);
  }
}

export async function prewarmOpenAiApiKey(): Promise<void> {
  const key = await resolveOpenAiApiKey();
  logEvent("info", "voice.api_key.prewarm", { found: Boolean(key) });
}
