/**
 * Microphone capture inside the renderer, for the platforms where the main
 * process has no recorder to spawn — `parecord` is PulseAudio and does not
 * exist on Windows. Chromium records here and only the encoded bytes cross
 * the IPC boundary, so the main process still owns the API key and the
 * upload.
 */

/** Containers asked for in order; Chromium picks the first it can encode. */
const PREFERRED_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

interface ActiveCapture {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
}

let active: ActiveCapture | null = null;

export function isCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined"
    && typeof navigator.mediaDevices?.getUserMedia === "function"
    && typeof MediaRecorder !== "undefined"
  );
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

/** Releases the microphone; the OS indicator must not linger after a pane. */
function releaseCapture(capture: ActiveCapture): void {
  for (const track of capture.stream.getTracks()) {
    track.stop();
  }
  if (active === capture) active = null;
}

export async function startCapture(): Promise<void> {
  if (active) throw new Error("Já existe uma gravação em andamento.");
  if (!isCaptureSupported()) {
    throw new Error("Este sistema não expõe captura de áudio ao aplicativo.");
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    // NotAllowedError covers both the Windows privacy setting and a denied
    // in-app prompt; either way the user has to act outside this button.
    const denied = (error as DOMException)?.name === "NotAllowedError";
    throw new Error(
      denied
        ? "Acesso ao microfone negado. Libere o microfone para o aplicativo nas configurações do sistema."
        : "Não foi possível abrir o microfone.",
    );
  }

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const capture: ActiveCapture = { recorder, stream, chunks: [] };
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) capture.chunks.push(event.data);
  };
  active = capture;

  try {
    recorder.start();
  } catch (error) {
    releaseCapture(capture);
    throw new Error("Não foi possível iniciar a gravação.");
  }
}

/** Stops the recorder and resolves with everything it produced. */
function collect(capture: ActiveCapture): Promise<Blob> {
  return new Promise((resolve, reject) => {
    capture.recorder.onstop = () => {
      resolve(new Blob(capture.chunks, { type: capture.recorder.mimeType }));
    };
    capture.recorder.onerror = () => reject(new Error("Falha ao gravar o áudio."));
    try {
      capture.recorder.stop();
    } catch {
      reject(new Error("Falha ao encerrar a gravação."));
    }
  });
}

export async function stopCaptureAndTranscribe(): Promise<string> {
  const capture = active;
  if (!capture) throw new Error("Nenhuma gravação em andamento.");

  try {
    const blob = await collect(capture);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // The container carries the codec after a `;`, which the main process
    // does not need and will not recognise.
    const mimeType = (blob.type || "audio/webm").split(";")[0];
    return await window.headTerminal.voice.transcribeAudio(bytes, mimeType);
  } finally {
    releaseCapture(capture);
  }
}

export function cancelCapture(): void {
  if (!active) return;
  const capture = active;
  try {
    if (capture.recorder.state !== "inactive") capture.recorder.stop();
  } catch {
    // The recorder may already have stopped on its own.
  }
  releaseCapture(capture);
}
