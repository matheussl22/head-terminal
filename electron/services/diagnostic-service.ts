import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { CheckpointInput } from "../types/api";

const LOG_FILES = [
  "startup.log",
  "events.jsonl",
  "checkpoints.jsonl",
  "frontend.log",
  "panic.log",
] as const;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;

export function defaultDiagnosticDirectory(): string {
  return process.platform === "linux"
    ? join(homedir(), ".local", "share", "head-terminal", "logs")
    : join(homedir(), ".head-terminal", "logs");
}

export interface DiagnosticServiceOptions {
  logDirectory?: string;
  channel?: "dev" | "prod";
  runId?: string;
  now?: () => Date;
  maxLogBytes?: number;
}

export class DiagnosticService {
  readonly logDirectory: string;
  readonly #channel: "dev" | "prod";
  readonly #runId: string;
  readonly #now: () => Date;
  readonly #maxLogBytes: number;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: DiagnosticServiceOptions = {}) {
    this.logDirectory = options.logDirectory ?? defaultDiagnosticDirectory();
    this.#channel = options.channel ?? (process.env.NODE_ENV === "development" ? "dev" : "prod");
    this.#runId = options.runId ?? randomUUID().replaceAll("-", "");
    this.#now = options.now ?? (() => new Date());
    this.#maxLogBytes = options.maxLogBytes ?? MAX_LOG_BYTES;
  }

  appendEvent(line: string): void {
    this.#enqueueAppend("events.jsonl", line);
  }

  appendFrontend(line: string): void {
    this.#enqueueAppend("frontend.log", line);
  }

  appendCheckpoint(input: CheckpointInput): void {
    const payload = JSON.stringify({
      ts: String(Math.floor(this.#now().getTime() / 1_000)),
      runId: this.#runId,
      channel: this.#channel,
      stage: input.checkpoint,
      elapsedMs: input.elapsedMs,
      meta: input.metadata ?? null,
    });
    this.#enqueueAppend("checkpoints.jsonl", payload);
  }

  async flush(): Promise<void> {
    await this.#writeQueue;
  }

  async export(frontend: unknown): Promise<string> {
    await this.flush();
    await mkdir(this.logDirectory, { recursive: true });
    const files: Array<{ name: string; content: string }> = [];
    for (const name of LOG_FILES) {
      try {
        files.push({ name, content: await readFile(join(this.logDirectory, name), "utf8") });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }

    const stamp = String(Math.floor(this.#now().getTime() / 1_000));
    const bundlePath = join(
      this.logDirectory,
      `head-terminal-diag-${this.#runId}-${stamp}.json`,
    );
    await writeFile(bundlePath, JSON.stringify({
      runId: this.#runId,
      channel: this.#channel,
      exportedAt: stamp,
      frontend,
      files,
    }, null, 2), { encoding: "utf8", mode: 0o600 });
    return bundlePath;
  }

  #enqueueAppend(filename: typeof LOG_FILES[number], line: string): void {
    const normalized = line.replace(/[\r\n]+$/u, "");
    if (Buffer.byteLength(normalized) > MAX_LINE_BYTES) {
      return;
    }
    this.#writeQueue = this.#writeQueue
      .catch(() => undefined)
      .then(() => this.#append(filename, normalized));
  }

  async #append(filename: typeof LOG_FILES[number], line: string): Promise<void> {
    await mkdir(this.logDirectory, { recursive: true });
    const path = join(this.logDirectory, filename);
    try {
      if ((await stat(path)).size >= this.#maxLogBytes) {
        await rename(path, `${path}.1`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await appendFile(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
