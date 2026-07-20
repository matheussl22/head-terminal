import { randomUUID } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";

const TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const WAV_HEADER_BYTES = 44;

interface RecorderProcess {
  readonly pid?: number;
  readonly exitCode: number | null;
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

type SpawnRecorder = (
  command: string,
  args: string[],
  options: { stdio: "ignore" },
) => RecorderProcess;

export interface VoiceSecretReader {
  get(key: "openai-api-key"): Promise<string | null>;
}

export interface VoiceServiceOptions {
  secrets: VoiceSecretReader;
  spawn?: SpawnRecorder;
  fetch?: typeof fetch;
  tempDirectory?: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  transcriptionTimeoutMs?: number;
  maxRecordingMs?: number;
}

interface ActiveRecording {
  child: RecorderProcess;
  wavPath: string;
  ownerId?: number;
  maxTimer?: ReturnType<typeof setTimeout>;
}

function timer(ms: number, callback: () => void): ReturnType<typeof setTimeout> {
  const handle = setTimeout(callback, ms);
  handle.unref?.();
  return handle;
}

export class VoiceService {
  private readonly secrets: VoiceSecretReader;
  private readonly spawnRecorder: SpawnRecorder;
  private readonly fetchImpl: typeof fetch;
  private readonly tempDirectory: string;
  private readonly startupTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly transcriptionTimeoutMs: number;
  private readonly maxRecordingMs: number;
  private recording: ActiveRecording | null = null;

  constructor(options: VoiceServiceOptions) {
    if (!options?.secrets) throw new TypeError("VoiceService requires a secret reader");
    this.secrets = options.secrets;
    this.spawnRecorder = options.spawn ?? (nodeSpawn as unknown as SpawnRecorder);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.tempDirectory = options.tempDirectory ?? os.tmpdir();
    this.startupTimeoutMs = options.startupTimeoutMs ?? 5_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 2_000;
    this.transcriptionTimeoutMs = options.transcriptionTimeoutMs ?? 60_000;
    this.maxRecordingMs = options.maxRecordingMs ?? 5 * 60_000;
  }

  async start(ownerId?: number): Promise<void> {
    if (this.recording) throw new Error("Já existe uma gravação em andamento.");
    if (
      ownerId !== undefined &&
      (!Number.isSafeInteger(ownerId) || ownerId <= 0)
    ) {
      throw new TypeError("Voice ownerId must be a positive WebContents id");
    }

    const wavPath = path.join(
      this.tempDirectory,
      `head-terminal-voice-${process.pid}-${randomUUID()}.wav`,
    );
    let child: RecorderProcess;
    try {
      child = this.spawnRecorder(
        "parecord",
        [
          "--file-format=wav",
          "--rate=16000",
          "--channels=1",
          "--latency-msec=20",
          wavPath,
        ],
        { stdio: "ignore" },
      );
    } catch (error) {
      await this.removeWav(wavPath);
      throw new Error(`Não foi possível iniciar a gravação: ${this.message(error)}`);
    }

    const active: ActiveRecording = { child, wavPath, ownerId };
    this.recording = active;
    try {
      await this.waitForSpawn(child);
    } catch (error) {
      if (this.recording === active) this.recording = null;
      await this.stopRecorder(child);
      await this.removeWav(wavPath);
      throw error;
    }

    if (this.recording !== active) return;
    active.maxTimer = timer(this.maxRecordingMs, () => {
      void this.cancelActive(active);
    });

    child.once("exit", () => {
      if (this.recording !== active) return;
      this.recording = null;
      if (active.maxTimer) clearTimeout(active.maxTimer);
      void this.removeWav(active.wavPath);
    });
    child.once("error", () => {
      if (this.recording !== active) return;
      this.recording = null;
      if (active.maxTimer) clearTimeout(active.maxTimer);
      void this.removeWav(active.wavPath);
    });
    if (child.exitCode !== null && this.recording === active) {
      this.recording = null;
      if (active.maxTimer) clearTimeout(active.maxTimer);
      await this.removeWav(active.wavPath);
    }
  }

  async stopAndTranscribe(): Promise<string> {
    const active = this.takeRecording();
    if (!active) throw new Error("Nenhuma gravação em andamento.");

    await this.stopRecorder(active.child);
    try {
      const metadata = await stat(active.wavPath).catch(() => null);
      if (!metadata) throw new Error("Arquivo de áudio não foi gerado.");
      if (metadata.size <= WAV_HEADER_BYTES) {
        throw new Error(
          "Gravação muito curta ou sem áudio. Fale por pelo menos 1 segundo.",
        );
      }

      const apiKey = (await this.secrets.get("openai-api-key"))?.trim() ?? "";
      if (!apiKey) {
        throw new Error("Configure sua chave da OpenAI nas Configurações.");
      }

      return await this.transcribe(active.wavPath, apiKey);
    } finally {
      await this.removeWav(active.wavPath);
    }
  }

  async cancel(): Promise<void> {
    const active = this.takeRecording();
    if (!active) return;
    await this.stopRecorder(active.child);
    await this.removeWav(active.wavPath);
  }

  /** Cancels only a recording owned by the renderer being destroyed. */
  async cleanup(ownerId?: number): Promise<void> {
    if (!this.recording) return;
    if (ownerId !== undefined && this.recording.ownerId !== ownerId) return;
    await this.cancel();
  }

  async dispose(): Promise<void> {
    await this.cleanup();
  }

  get isRecording(): boolean {
    return this.recording !== null;
  }

  private takeRecording(): ActiveRecording | null {
    const active = this.recording;
    if (!active) return null;
    this.recording = null;
    if (active.maxTimer) clearTimeout(active.maxTimer);
    return active;
  }

  private async cancelActive(active: ActiveRecording): Promise<void> {
    if (this.recording !== active) return;
    this.recording = null;
    await this.stopRecorder(active.child);
    await this.removeWav(active.wavPath);
  }

  private waitForSpawn(child: RecorderProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onError);
        error ? reject(error) : resolve();
      };
      const onSpawn = () => finish();
      const onError = (error: Error) =>
        finish(new Error(`Não foi possível iniciar a gravação: ${error.message}`));
      const timeout = timer(this.startupTimeoutMs, () =>
        finish(new Error("A inicialização do gravador demorou demais.")),
      );
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  private async stopRecorder(child: RecorderProcess): Promise<void> {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        child.removeListener("exit", onExit);
        resolve();
      };
      const onExit = () => finish();
      child.once("exit", onExit);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
        return;
      }
      killTimer = timer(this.stopTimeoutMs, () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // It may have exited between the timeout and kill.
        }
        finish();
      });
      if (child.exitCode !== null) finish();
    });
  }

  private async transcribe(wavPath: string, apiKey: string): Promise<string> {
    const bytes = await readFile(wavPath);
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: "audio/wav" }),
      "audio.wav",
    );
    form.append("model", "gpt-4o-transcribe");
    form.append("language", "pt");

    const abort = new AbortController();
    const timeout = timer(this.transcriptionTimeoutMs, () => abort.abort());
    let response: Response;
    try {
      response = await this.fetchImpl(TRANSCRIPTION_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        throw new Error("A transcrição demorou demais e foi cancelada.");
      }
      throw new Error("Falha de rede ao contatar a OpenAI.", { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    const body = (await response.json().catch(() => ({}))) as {
      text?: unknown;
      error?: { message?: unknown };
    };
    if (!response.ok) {
      const detail =
        typeof body.error?.message === "string"
          ? body.error.message
          : `Erro HTTP ${response.status}`;
      throw new Error(`Falha na transcrição: ${detail}`);
    }
    if (typeof body.text !== "string") {
      throw new Error("Não foi possível interpretar a resposta da OpenAI.");
    }
    return body.text.trim();
  }

  private async removeWav(wavPath: string): Promise<void> {
    await unlink(wavPath).catch(() => undefined);
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
