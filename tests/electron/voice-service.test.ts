import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VoiceService } from "../../electron/services/voice-service";

class FakeRecorder extends EventEmitter {
  readonly pid = 1234;
  exitCode: number | null = null;
  readonly signals: NodeJS.Signals[] = [];
  autoExit = true;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (this.autoExit) {
      this.exitCode = 0;
      queueMicrotask(() => this.emit("exit", 0, signal));
    }
    return true;
  }
}

function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

describe("VoiceService", () => {
  let tempDirectory: string;
  let recorders: FakeRecorder[];
  let wavPaths: string[];
  let secretGet: ReturnType<typeof vi.fn<(key: "openai-api-key") => Promise<string | null>>>;

  beforeEach(async () => {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "head-terminal-voice-test-"));
    recorders = [];
    wavPaths = [];
    secretGet = vi.fn(async () => "sk-main-only");
  });

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });

  function createService(
    overrides: Partial<ConstructorParameters<typeof VoiceService>[0]> = {},
  ) {
    return new VoiceService({
      secrets: { get: secretGet },
      tempDirectory,
      startupTimeoutMs: 30,
      stopTimeoutMs: 10,
      transcriptionTimeoutMs: 30,
      maxRecordingMs: 1_000,
      spawn: (_command, args) => {
        const recorder = new FakeRecorder();
        recorders.push(recorder);
        wavPaths.push(args.at(-1)!);
        queueMicrotask(() => recorder.emit("spawn"));
        return recorder;
      },
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ text: "  texto transcrito  " }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
      ...overrides,
    });
  }

  it("starts parecord with low-latency mono WAV arguments", async () => {
    const spawn = vi.fn((_command: string, args: string[]) => {
      const recorder = new FakeRecorder();
      recorders.push(recorder);
      wavPaths.push(args.at(-1)!);
      queueMicrotask(() => recorder.emit("spawn"));
      return recorder;
    });
    const service = createService({ spawn });

    await service.start(7);

    expect(spawn).toHaveBeenCalledWith(
      "parecord",
      expect.arrayContaining([
        "--file-format=wav",
        "--rate=16000",
        "--channels=1",
        "--latency-msec=20",
      ]),
      { stdio: "ignore" },
    );
    expect(service.isRecording).toBe(true);
    await service.cancel();
  });

  it("sends SIGTERM, transcribes in main with the stored key and always removes WAV", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: "Bearer sk-main-only" });
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ text: "  olá mundo  " }), { status: 200 });
    });
    const service = createService({ fetch: fetchMock });
    await service.start();
    await writeFile(wavPaths[0]!, Buffer.alloc(100, 1));

    await expect(service.stopAndTranscribe()).resolves.toBe("olá mundo");

    expect(secretGet).toHaveBeenCalledWith("openai-api-key");
    expect(recorders[0]?.signals[0]).toBe("SIGTERM");
    expect(await exists(wavPaths[0]!)).toBe(false);
  });

  it("rejects header-only audio and removes it", async () => {
    const fetchMock = vi.fn();
    const service = createService({ fetch: fetchMock });
    await service.start();
    await writeFile(wavPaths[0]!, Buffer.alloc(44));

    await expect(service.stopAndTranscribe()).rejects.toThrow("muito curta");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await exists(wavPaths[0]!)).toBe(false);
  });

  it("does not call OpenAI without a main-process secret and still cleans up", async () => {
    secretGet.mockResolvedValue(null);
    const fetchMock = vi.fn();
    const service = createService({ fetch: fetchMock });
    await service.start();
    await writeFile(wavPaths[0]!, Buffer.alloc(100));

    await expect(service.stopAndTranscribe()).rejects.toThrow("Configure sua chave");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await exists(wavPaths[0]!)).toBe(false);
  });

  it("surfaces OpenAI errors without including the API key and removes WAV", async () => {
    const service = createService({
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "invalid credentials" } }), {
          status: 401,
        }),
      ),
    });
    await service.start();
    await writeFile(wavPaths[0]!, Buffer.alloc(100));

    const error = await service.stopAndTranscribe().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid credentials");
    expect((error as Error).message).not.toContain("sk-main-only");
    expect(await exists(wavPaths[0]!)).toBe(false);
  });

  it("aborts a timed-out transcription and removes WAV", async () => {
    const service = createService({
      transcriptionTimeoutMs: 5,
      fetch: vi.fn((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      ),
    });
    await service.start();
    await writeFile(wavPaths[0]!, Buffer.alloc(100));

    await expect(service.stopAndTranscribe()).rejects.toThrow("demorou demais");
    expect(await exists(wavPaths[0]!)).toBe(false);
  });

  it("cancel is idempotent, sends SIGTERM and removes WAV", async () => {
    const service = createService();
    await service.start();
    await writeFile(wavPaths[0]!, Buffer.alloc(100));

    await service.cancel();
    await service.cancel();

    expect(recorders[0]?.signals).toEqual(["SIGTERM"]);
    expect(await exists(wavPaths[0]!)).toBe(false);
    expect(service.isRecording).toBe(false);
  });

  it("escalates to SIGKILL when parecord ignores SIGTERM", async () => {
    const service = createService();
    await service.start();
    recorders[0]!.autoExit = false;

    await service.cancel();

    expect(recorders[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("cleans only the recording owned by a destroyed renderer", async () => {
    const service = createService();
    await service.start(17);
    await writeFile(wavPaths[0]!, Buffer.alloc(100));

    await service.cleanup(18);
    expect(service.isRecording).toBe(true);
    await service.cleanup(17);
    expect(service.isRecording).toBe(false);
    expect(await exists(wavPaths[0]!)).toBe(false);
  });

  it("cleans up when parecord fails during startup", async () => {
    const service = createService({
      spawn: (_command, args) => {
        const recorder = new FakeRecorder();
        wavPaths.push(args.at(-1)!);
        queueMicrotask(() => recorder.emit("error", new Error("not found")));
        return recorder;
      },
    });

    await expect(service.start()).rejects.toThrow("not found");
    expect(service.isRecording).toBe(false);
    expect(await exists(wavPaths[0]!)).toBe(false);
  });

  describe("audio captured by the renderer", () => {
    // On Windows there is no `parecord` to spawn, so the bytes arrive already
    // encoded and the main process only owns the key and the upload.
    const audio = new Uint8Array(4_096).fill(7);

    it("uploads the bytes under the container the renderer named", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ text: " olá mundo " }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const service = createService({ fetch: fetchImpl });

      expect(await service.transcribeAudio(audio, "audio/webm")).toBe("olá mundo");

      const body = fetchImpl.mock.calls[0]![1]!.body as FormData;
      const file = body.get("file") as File;
      expect(file.type).toBe("audio/webm");
      expect(file.size).toBe(audio.byteLength);
      // No recorder was ever spawned for this path.
      expect(recorders).toHaveLength(0);
    });

    it("falls back to webm for a container it does not know", async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ text: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const service = createService({ fetch: fetchImpl });

      await service.transcribeAudio(audio, "audio/aiff-c; codecs=nonsense");
      const file = (fetchImpl.mock.calls[0]![1]!.body as FormData).get("file") as File;
      expect(file.type).toBe("audio/webm");
    });

    it("refuses audio too short to hold speech", async () => {
      const service = createService();
      await expect(service.transcribeAudio(new Uint8Array(16), "audio/webm"))
        .rejects.toThrow("muito curta");
    });

    it("refuses an empty recording", async () => {
      const service = createService();
      await expect(service.transcribeAudio(new Uint8Array(0), "audio/webm"))
        .rejects.toThrow("vazio");
    });

    it("asks for the API key before uploading anything", async () => {
      secretGet = vi.fn(async () => null);
      const fetchImpl = vi.fn();
      const service = createService({ fetch: fetchImpl });

      await expect(service.transcribeAudio(audio, "audio/webm"))
        .rejects.toThrow("Configure sua chave da OpenAI");
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});

