import { invoke } from "@tauri-apps/api/core";

export async function startVoiceRecording(): Promise<void> {
  await invoke("start_voice_recording");
}

export async function stopAndTranscribeVoice(apiKey: string): Promise<string> {
  return await invoke<string>("stop_and_transcribe_voice", { apiKey });
}
