import { createRequire } from "node:module";
import { accessSync, constants } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  PtyService,
  type PtyServiceEvent,
} from "../../electron/services/pty-service";

const require = createRequire(import.meta.url);
const ZSH = "/usr/bin/zsh";
const EVENT_TIMEOUT_MS = 5_000;

let skipReason: string | null = null;
try {
  const loaded = require("node-pty") as { spawn?: unknown };
  if (typeof loaded.spawn !== "function") {
    throw new Error("node-pty loaded without a spawn function");
  }
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "MODULE_NOT_FOUND") {
    skipReason = "node-pty is not installed";
  } else {
    // ABI/load errors are product failures, not an excuse to skip integration.
    throw error;
  }
}

// This suite drives a real POSIX shell in the host. On Windows a pane's zsh
// lives inside the distro instead, and node-pty here would only ever spawn
// `wsl.exe` — that boundary is covered by wsl-launch.verify.test.ts.
if (!skipReason) {
  try {
    accessSync(ZSH, constants.X_OK);
  } catch {
    skipReason = `${ZSH} is not executable on this host`;
  }
}

class EventCollector {
  readonly events: PtyServiceEvent[] = [];
  readonly #waiters = new Set<() => void>();

  emit = (event: PtyServiceEvent): void => {
    this.events.push(event);
    for (const notify of [...this.#waiters]) notify();
  };

  output(id: string): string {
    return this.events
      .filter(
        (event): event is Extract<PtyServiceEvent, { channel: "pty:data" }> =>
          event.channel === "pty:data" && event.payload.id === id,
      )
      .map((event) => event.payload.data)
      .join("");
  }

  async waitForOutput(
    id: string,
    predicate: (output: string) => boolean,
    timeoutMs = EVENT_TIMEOUT_MS,
  ): Promise<string> {
    return this.waitFor(() => {
      const output = this.output(id);
      return predicate(output) ? output : null;
    }, `PTY ${id} output`, timeoutMs);
  }

  async waitForExit(
    id: string,
    timeoutMs = EVENT_TIMEOUT_MS,
  ): Promise<Extract<PtyServiceEvent, { channel: "pty:exit" }>["payload"]> {
    return this.waitFor(
      () =>
        this.events.find(
          (event): event is Extract<PtyServiceEvent, { channel: "pty:exit" }> =>
            event.channel === "pty:exit" && event.payload.id === id,
        )?.payload ?? null,
      `PTY ${id} exit`,
      timeoutMs,
    );
  }

  private async waitFor<T>(
    read: () => T | null,
    description: string,
    timeoutMs: number,
  ): Promise<T> {
    const immediate = read();
    if (immediate !== null) return immediate;

    return new Promise<T>((resolve, reject) => {
      const finish = () => {
        const value = read();
        if (value === null) return;
        clearTimeout(timeout);
        this.#waiters.delete(finish);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        this.#waiters.delete(finish);
        reject(
          new Error(
            `Timed out waiting for ${description}. Output: ${JSON.stringify(this.events)}`,
          ),
        );
      }, timeoutMs);
      this.#waiters.add(finish);
    });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} remained alive after PTY cleanup`);
}

function spawnShell(
  service: PtyService,
  ownerId: number,
  id: string,
): { id: string; pid: number } {
  return service.spawn(ownerId, {
    id,
    command: ZSH,
    args: ["-f"],
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
  });
}

const liveServices: PtyService[] = [];

afterEach(async () => {
  for (const service of liveServices.splice(0)) {
    service.dispose();
  }
});

describe.skipIf(Boolean(skipReason))(
  `real node-pty integration${skipReason ? ` (${skipReason})` : ""}`,
  () => {
    it("preserves Unicode, OSC and ANSI bytes and supports write/resize/exit", async () => {
      const collector = new EventCollector();
      const service = new PtyService({ emit: collector.emit });
      liveServices.push(service);
      const ownerId = 101;
      const handle = spawnShell(service, ownerId, "real-io");

      service.write(ownerId, handle.id, "printf '__READY__\\n'\r");
      await collector.waitForOutput(handle.id, (output) => output.includes("__READY__"));

      service.resize(ownerId, handle.id, 132, 44);
      service.write(ownerId, handle.id, "stty size\r");
      await collector.waitForOutput(handle.id, (output) => /44\s+132/u.test(output));

      service.write(
        ownerId,
        handle.id,
        "printf 'UNICODE:%s\\n' 'á漢🙂'; " +
          "printf '\\033]7770;agent-exited:7\\007'; " +
          "printf '\\033[31mRED\\033[0m\\n'\r",
      );
      const output = await collector.waitForOutput(
        handle.id,
        (text) =>
          text.includes("UNICODE:á漢🙂") &&
          text.includes("\x1b]7770;agent-exited:7\x07") &&
          text.includes("\x1b[31mRED\x1b[0m"),
      );
      expect(output).toContain("UNICODE:á漢🙂");
      expect(output).toContain("\x1b]7770;agent-exited:7\x07");
      expect(output).toContain("\x1b[31mRED\x1b[0m");

      service.write(ownerId, handle.id, "exit 23\r");
      await expect(collector.waitForExit(handle.id)).resolves.toMatchObject({
        id: handle.id,
        exitCode: 23,
      });
      expect(service.has(ownerId, handle.id)).toBe(false);
      await waitForProcessExit(handle.pid);
    });

    it("delivers Ctrl+C to an active foreground command", async () => {
      const collector = new EventCollector();
      const service = new PtyService({ emit: collector.emit });
      liveServices.push(service);
      const ownerId = 102;
      const handle = spawnShell(service, ownerId, "real-sigint");

      service.write(ownerId, handle.id, "printf '__CTRL_READY__\\n'\r");
      await collector.waitForOutput(handle.id, (output) =>
        output.includes("__CTRL_READY__"),
      );
      service.write(ownerId, handle.id, "stty -echo\r");
      await new Promise((resolve) => setTimeout(resolve, 50));
      service.write(ownerId, handle.id, "sleep 30\r");
      await new Promise((resolve) => setTimeout(resolve, 150));
      service.write(ownerId, handle.id, "\x03");
      await new Promise((resolve) => setTimeout(resolve, 50));
      service.write(ownerId, handle.id, "printf '__AFTER_CTRL_C__\\n'\r");

      await expect(
        collector.waitForOutput(handle.id, (output) =>
          output.includes("__AFTER_CTRL_C__"),
        ),
      ).resolves.toContain("__AFTER_CTRL_C__");
    });

    it("runs multiple isolated PTYs and cleans all owned processes", async () => {
      const collector = new EventCollector();
      const service = new PtyService({ emit: collector.emit });
      liveServices.push(service);
      const ownerId = 103;
      const handles = Array.from({ length: 6 }, (_, index) =>
        spawnShell(service, ownerId, `real-multi-${index}`),
      );

      for (const [index, handle] of handles.entries()) {
        service.write(
          ownerId,
          handle.id,
          `printf '__PANE_${index}__\\n'\r`,
        );
      }
      await Promise.all(
        handles.map((handle, index) =>
          collector.waitForOutput(handle.id, (output) => {
            const marker = `__PANE_${index}__`;
            return output.indexOf(marker) !== output.lastIndexOf(marker);
          }),
        ),
      );
      expect(service.size).toBe(6);
      expect(service.cleanup(ownerId)).toBe(6);
      expect(service.size).toBe(0);
      await Promise.all(handles.map((handle) => waitForProcessExit(handle.pid)));
    });

    it("kills the PTY shell and its background child without leaving orphans", async () => {
      const collector = new EventCollector();
      const service = new PtyService({ emit: collector.emit });
      liveServices.push(service);
      const ownerId = 104;
      const handle = spawnShell(service, ownerId, "real-orphan");

      service.write(
        ownerId,
        handle.id,
        "sleep 30 & printf 'CHILD:%s\\n' $!\r",
      );
      const output = await collector.waitForOutput(
        handle.id,
        (text) => /CHILD:\d+/u.test(text),
      );
      const childPid = Number(/CHILD:(\d+)/u.exec(output)?.[1]);
      expect(Number.isSafeInteger(childPid)).toBe(true);
      expect(isProcessAlive(handle.pid)).toBe(true);
      expect(isProcessAlive(childPid)).toBe(true);

      expect(service.cleanup(ownerId)).toBe(1);
      try {
        await Promise.all([
          waitForProcessExit(handle.pid),
          waitForProcessExit(childPid),
        ]);
      } finally {
        // Keep the regression visible while ensuring a failed test never
        // pollutes the developer/CI machine with the orphan it detected.
        for (const pid of [handle.pid, childPid]) {
          if (isProcessAlive(pid)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // It may exit between the liveness probe and emergency cleanup.
            }
          }
        }
      }
    });
  },
);
