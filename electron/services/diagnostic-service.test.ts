import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DiagnosticService } from "./diagnostic-service";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("diagnostic-service", () => {
  it("serializes appends in call order and exports the Rust-compatible bundle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ht-diagnostic-"));
    cleanup.push(directory);
    const service = new DiagnosticService({
      logDirectory: directory,
      runId: "run-test",
      channel: "dev",
      now: () => new Date("2026-07-19T12:00:00.000Z"),
    });

    service.appendEvent('{"sequence":1}');
    service.appendEvent('{"sequence":2}');
    service.appendCheckpoint({ checkpoint: "ui.ready", elapsedMs: 42, metadata: { panes: 2 } });
    const bundlePath = await service.export({ renderer: "ready" });

    expect(await readFile(join(directory, "events.jsonl"), "utf8"))
      .toBe('{"sequence":1}\n{"sequence":2}\n');
    const checkpoint = JSON.parse((await readFile(join(directory, "checkpoints.jsonl"), "utf8")).trim());
    expect(checkpoint).toMatchObject({ runId: "run-test", channel: "dev", stage: "ui.ready", elapsedMs: 42 });
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    expect(bundle.frontend).toEqual({ renderer: "ready" });
    expect(bundle.files.map((file: { name: string }) => file.name)).toEqual([
      "events.jsonl", "checkpoints.jsonl",
    ]);
  });

  it("rotates a full log before appending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ht-diagnostic-"));
    cleanup.push(directory);
    const service = new DiagnosticService({ logDirectory: directory, maxLogBytes: 4 });
    service.appendEvent("1234");
    service.appendEvent("next");
    await service.flush();
    expect(await readFile(join(directory, "events.jsonl.1"), "utf8")).toBe("1234\n");
    expect(await readFile(join(directory, "events.jsonl"), "utf8")).toBe("next\n");
  });
});
