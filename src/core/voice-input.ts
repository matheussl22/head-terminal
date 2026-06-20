import { sendTextToPane } from "../actions/sendAgentCommand";
import { logEvent } from "./logger";
import { useSessionStore } from "./session-manager";
import { startVoiceRecording, stopAndTranscribeVoice } from "./voice-bridge";

let audioCtx: AudioContext | null = null;

// ponytail: Web Audio beep instead of shipping an audio file — two sine
// blips (high = started, low = stopped), kept quiet with a fast envelope.
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
    return;
  }

  const {
    voiceRecordingPaneId,
    setVoiceRecordingPaneId,
    setVoiceTranscribingPaneId,
  } = useSessionStore.getState();

  if (voiceRecordingPaneId !== paneId) {
    try {
      setVoiceRecordingPaneId(paneId);
      await startVoiceRecording();
      beep(880);
    } catch (error) {
      setVoiceRecordingPaneId(null);
      logEvent("error", "voice.start_failed", {
        paneId,
        message: error instanceof Error ? error.message : String(error),
      });
      options?.onError?.();
    }
    return;
  }

  setVoiceRecordingPaneId(null);
  setVoiceTranscribingPaneId(paneId);
  beep(440);
  try {
    const text = await stopAndTranscribeVoice();
    if (text) {
      sendTextToPane(paneId, text);
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
