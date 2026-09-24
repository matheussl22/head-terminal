import { freemem, totalmem } from "node:os";

import { describe, expect, it } from "vitest";

import {
  cpuPercentBetween,
  createResourceUsageReader,
  diskUsageFrom,
  createMemoryReader,
  memoryFromMeminfo,
  memoryFromVmStat,
  sampleCpuTimes,
  volumeLabel,
} from "./resource-usage-service";

function core(times: Partial<{
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}>) {
  return {
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, ...times },
  };
}

const NO_MEMORY = () => ({ free: 0, total: 0 });
const NO_DISK = async () => null;

describe("resource-usage-service", () => {
  it("sums idle and total jiffies across every core", () => {
    expect(
      sampleCpuTimes([
        core({ user: 100, sys: 50, idle: 850 }),
        core({ user: 200, irq: 10, idle: 790 }),
      ]),
    ).toEqual({ idle: 1_640, total: 2_000 });
  });

  it("reports the busy share of the window between two samples", () => {
    expect(
      cpuPercentBetween({ idle: 1_000, total: 2_000 }, { idle: 1_300, total: 2_400 }),
    ).toBe(25);
  });

  it("reports zero when no CPU time elapsed or counters went backwards", () => {
    const sample = { idle: 1_000, total: 2_000 };
    expect(cpuPercentBetween(sample, sample)).toBe(0);
    expect(cpuPercentBetween(sample, { idle: 500, total: 1_000 })).toBe(0);
    // Suspend/resume can move idle back while total moves forward.
    expect(cpuPercentBetween(sample, { idle: 900, total: 2_400 })).toBe(0);
  });

  it("falls back to the since-boot average on the first read", async () => {
    const read = createResourceUsageReader({
      sampleCpu: () => ({ idle: 700, total: 1_000 }),
      readMemory: NO_MEMORY,
      readDisk: NO_DISK,
    });
    await expect(read().then((usage) => usage.cpuPercent)).resolves.toBe(30);
  });

  it("compares each read against the previous one", async () => {
    const samples = [
      { idle: 700, total: 1_000 },
      { idle: 900, total: 2_000 }, // 800 busy of 1000
      { idle: 1_800, total: 3_000 }, // 100 busy of 1000
    ];
    let index = 0;
    const read = createResourceUsageReader({
      sampleCpu: () => samples[index++],
      readMemory: NO_MEMORY,
      readDisk: NO_DISK,
    });

    await read();
    expect((await read()).cpuPercent).toBe(80);
    expect((await read()).cpuPercent).toBe(10);
  });

  it("derives used memory from free/total", async () => {
    const read = createResourceUsageReader({
      sampleCpu: () => ({ idle: 0, total: 0 }),
      readMemory: () => ({ free: 4_000, total: 16_000 }),
      readDisk: NO_DISK,
    });
    await expect(read().then((usage) => usage.memory)).resolves.toEqual({
      usedBytes: 12_000,
      totalBytes: 16_000,
      percent: 75,
    });
  });

  it("accepts an async memory reader", async () => {
    const read = createResourceUsageReader({
      sampleCpu: () => ({ idle: 0, total: 0 }),
      readMemory: async () => ({ free: 4_000, total: 16_000 }),
      readDisk: NO_DISK,
    });
    await expect(read().then((usage) => usage.memory.percent)).resolves.toBe(75);
  });

  it("never divides by a zero total", async () => {
    const read = createResourceUsageReader({
      sampleCpu: () => ({ idle: 0, total: 0 }),
      readMemory: NO_MEMORY,
      readDisk: NO_DISK,
    });
    await expect(read().then((usage) => usage.memory)).resolves.toEqual({
      usedBytes: 0,
      totalBytes: 0,
      percent: 0,
    });
  });

  describe("macOS vm_stat", () => {
    // 16 KiB pages; a 32 GiB machine sitting mostly in file cache.
    const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     9436.
Pages active:                                 774260.
Pages inactive:                               915780.
Pages speculative:                              1639.
Pages throttled:                                   0.
Pages wired down:                             184732.
Pages purgeable:                               22877.
"Translation faults":                       37287533.
Pages copy-on-write:                         5732353.
File-backed pages:                           1021174.
Anonymous pages:                              670505.
Pages stored in compressor:                   371034.
Pages occupied by compressor:                 167682.
Swapouts:                                          0.
`;
    const TOTAL = 34_359_738_368;

    it("reports Activity Monitor's used figure, not the strictly free pool", () => {
      // wired + (anonymous - purgeable) + compressor = 1_000_042 pages.
      const used = 1_000_042 * 16_384;
      expect(memoryFromVmStat(VM_STAT, TOTAL)).toEqual({
        free: TOTAL - used,
        total: TOTAL,
      });
      // Through freemem() this same machine would read 99.6% used.
      expect((used / TOTAL) * 100).toBeCloseTo(47.7, 1);
    });

    it("never reports negative free memory", () => {
      expect(memoryFromVmStat(VM_STAT, 1_000)).toEqual({ free: 0, total: 1_000 });
    });

    it("rejects output missing a counter it needs", () => {
      const withoutAnonymous = VM_STAT.replace(/Anonymous pages:.*\n/u, "");
      expect(memoryFromVmStat(withoutAnonymous, TOTAL)).toBeNull();
      expect(memoryFromVmStat("", TOTAL)).toBeNull();
    });
  });

  describe("Linux /proc/meminfo", () => {
    it("prefers the kernel's MemAvailable estimate", () => {
      const meminfo = `MemTotal:       16000000 kB
MemFree:          500000 kB
MemAvailable:   12000000 kB
Buffers:          100000 kB
Cached:          8000000 kB
`;
      expect(memoryFromMeminfo(meminfo, 16_000_000 * 1024)).toEqual({
        free: 12_000_000 * 1024,
        total: 16_000_000 * 1024,
      });
    });

    it("approximates with free + buffers + cache on kernels without MemAvailable", () => {
      const meminfo = `MemTotal:       16000000 kB
MemFree:          500000 kB
Buffers:          100000 kB
Cached:          8000000 kB
SReclaimable:     400000 kB
`;
      expect(memoryFromMeminfo(meminfo, 16_000_000 * 1024)).toEqual({
        free: 9_000_000 * 1024,
        total: 16_000_000 * 1024,
      });
    });

    it("never reports more free than total", () => {
      expect(
        memoryFromMeminfo("MemTotal: 10 kB\nMemAvailable: 20 kB\n", 10 * 1024),
      ).toEqual({ free: 10 * 1024, total: 10 * 1024 });
    });

    it("rejects output without a free counter", () => {
      expect(memoryFromMeminfo("MemTotal: 10 kB\n", 10 * 1024)).toBeNull();
      expect(memoryFromMeminfo("", 0)).toBeNull();
    });
  });

  it("counts space this user cannot write as used disk", () => {
    // 400 blocks of 1000 bytes, 100 available: a reserved root pool inside
    // bfree still is not ours, so it lands on the used side.
    expect(diskUsageFrom({ bsize: 1_000, blocks: 400, bavail: 100 }, "C:")).toEqual({
      label: "C:",
      usedBytes: 300_000,
      totalBytes: 400_000,
      percent: 75,
    });
  });

  it("labels the volume by drive letter on Windows and by path elsewhere", () => {
    expect(volumeLabel("c:\Users\mathe", "win32")).toBe("C:");
    expect(volumeLabel("\\server\share", "win32")).toBe("\\server\share");
    expect(volumeLabel("/home/mathe", "linux")).toBe("/home/mathe");
  });

  it("keeps serving a null disk without re-reading the volume every poll", async () => {
    let reads = 0;
    let clock = 0;
    const read = createResourceUsageReader({
      sampleCpu: () => ({ idle: 0, total: 0 }),
      readMemory: NO_MEMORY,
      readDisk: async () => {
        reads += 1;
        return null;
      },
      now: () => clock,
    });

    await read();
    await read();
    expect(reads).toBe(1);

    clock = 10_000;
    await read();
    expect(reads).toBe(2);
  });

  it("caches the disk reading between polls", async () => {
    let reads = 0;
    let clock = 0;
    const disk = { label: "C:", usedBytes: 300, totalBytes: 400, percent: 75 };
    const read = createResourceUsageReader({
      sampleCpu: () => ({ idle: 0, total: 0 }),
      readMemory: NO_MEMORY,
      readDisk: async () => {
        reads += 1;
        return disk;
      },
      now: () => clock,
    });

    expect((await read()).disk).toEqual(disk);
    clock = 2_000;
    expect((await read()).disk).toEqual(disk);
    expect(reads).toBe(1);
  });
});

describe("createMemoryReader", () => {
  it("uses Node's own accounting on Windows, where freemem() is already right", async () => {
    const sample = await createMemoryReader("win32")();
    expect(sample.total).toBe(totalmem());
    expect(sample.free).toBeGreaterThan(0);
    expect(sample.free).toBeLessThanOrEqual(sample.total);
  });

  it("falls back to freemem() when the platform reader cannot run", async () => {
    // /proc/meminfo does not exist off Linux, and vm_stat does not exist off
    // macOS; either way the reader must still answer instead of throwing.
    const foreign: NodeJS.Platform = process.platform === "linux" ? "darwin" : "linux";
    const sample = await createMemoryReader(foreign)();
    expect(sample.total).toBe(totalmem());
    expect(Math.abs(sample.free - freemem())).toBeLessThan(2 * 1024 * 1024 * 1024);
  });

  it("reads the host's own monitor on macOS and Linux", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const sample = await createMemoryReader()();
    expect(sample.total).toBe(totalmem());
    expect(sample.free).toBeGreaterThan(0);
    expect(sample.free).toBeLessThanOrEqual(sample.total);
  });
});
