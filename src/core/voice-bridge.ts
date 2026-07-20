export async function startVoiceRecording(): Promise<void> {
  await window.headTerminal.voice.start();
}

export async function stopAndTranscribeVoice(_apiKey?: string): Promise<string> {
  return window.headTerminal.voice.stopAndTranscribe();
}

export async function cancelVoiceRecording(): Promise<void> {
  await window.headTerminal.voice.cancel();
}
