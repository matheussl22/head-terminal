import {
  cancelCapture,
  isCaptureSupported,
  startCapture,
  stopCaptureAndTranscribe,
} from "./voice-capture";

/**
 * Two ways to reach a microphone. The main process spawns `parecord`, which is
 * PulseAudio: on Windows there is nothing to spawn, so Chromium records in the
 * renderer instead. The choice is made here so callers never learn about it.
 * macOS keeps the existing path, untouched and untested from here.
 */
function recordsInRenderer(): boolean {
  return /Windows/u.test(navigator.userAgent) && isCaptureSupported();
}

export async function startVoiceRecording(): Promise<void> {
  if (recordsInRenderer()) {
    await startCapture();
    return;
  }
  await window.headTerminal.voice.start();
}

export async function stopAndTranscribeVoice(_apiKey?: string): Promise<string> {
  if (recordsInRenderer()) {
    return stopCaptureAndTranscribe();
  }
  return window.headTerminal.voice.stopAndTranscribe();
}

export async function cancelVoiceRecording(): Promise<void> {
  if (recordsInRenderer()) {
    cancelCapture();
    return;
  }
  await window.headTerminal.voice.cancel();
}
