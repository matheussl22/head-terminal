import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { cpus, freemem, homedir, totalmem } from "node:os";
import { promisify } from "node:util";

import type { DiskUsage, ResourceUsage, UsageSample } from "../types/api";

/** Disk barely moves between reads, so it is not worth a syscall every poll. */
const DISK_TTL_MS = 10_000;

export interface CpuTimesSample {
  /** Idle jiffies summed over every core. */
  idle: number;
  /** Idle + busy jiffies summed over every core. */
  total: number;
}

interface CpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

export function sampleCpuTimes(
  cores: ReadonlyArray<{ times: CpuTimes }> = cpus(),
): CpuTimesSample {
  let idle = 0;
  let total = 0;
  for (const { times } of cores) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

/**
 * Busy share of the window between two cumulative samples, 0-100.
 *
 * A window with no elapsed CPU time — two reads in the same tick, or counters
 * that went backwards after a suspend — has nothing to report, and 0 is the
 * only honest answer that keeps the meter from spiking on resume.
 */
export function cpuPercentBetween(
  previous: CpuTimesSample,
  current: CpuTimesSample,
): number {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0 || idleDelta < 0) {
    return 0;
  }
  return clampPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

export function usageSample(usedBytes: number, totalBytes: number): UsageSample {
  const total = Math.max(0, totalBytes);
  const used = Math.min(total, Math.max(0, usedBytes));
  return {
    usedBytes: used,
    totalBytes: total,
    percent: total > 0 ? clampPercent((used / total) * 100) : 0,
  };
}

/** The volume a path lives on — `C:` on Windows, the path itself elsewhere. */
export function volumeLabel(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") {
    return path;
  }
  const drive = /^([a-z]):/iu.exec(path);
  return drive ? `${drive[1].toUpperCase()}:` : path;
}

export interface FilesystemStats {
  bsize: number;
  blocks: number;
  bavail: number;
}

/**
 * Free space is taken from `bavail` — what this user may actually write — so
 * a reserved root pool counts as used, the same way it is unavailable to us.
 */
export function diskUsageFrom(
  stats: FilesystemStats,
  label: string,
): DiskUsage {
  const blockSize = Number(stats.bsize);
  const total = Number(stats.blocks) * blockSize;
  const available = Number(stats.bavail) * blockSize;
  return { label, ...usageSample(total - available, total) };
}

/** null on an unreadable volume — a disconnected network drive, or no access. */
async function statfsDisk(path: string): Promise<DiskUsage | null> {
  try {
    return diskUsageFrom(await statfs(path), volumeLabel(path));
  } catch {
    return null;
  }
}

export interface MemorySample {
  /** Bytes an application could take right now without evicting anything it would miss. */
  free: number;
  total: number;
}

/**
 * Activity Monitor's "Memory Used" from `vm_stat`: wired + app memory
 * (anonymous minus purgeable) + compressed. `os.freemem()` on macOS only
 * counts the strictly free pool, which the kernel keeps near zero by design —
 * file cache sits in "inactive" and is handed back on demand — so a healthy
 * machine reads 99% used through it.
 *
 * null when the output lacks a counter this needs (an old macOS, a locale that
 * renamed the labels), so the caller can fall back rather than mis-report.
 */
export function memoryFromVmStat(output: string, total: number): MemorySample | null {
  const pageSizeMatch = /page size of (\d+) bytes/u.exec(output);
  if (!pageSizeMatch) {
    return null;
  }
  const pageSize = Number(pageSizeMatch[1]);

  const pages = new Map<string, number>();
  for (const line of output.split("\n")) {
    const match = /^"?([^":]+)"?:\s+(\d+)\.?$/u.exec(line.trim());
    if (match) {
      pages.set(match[1], Number(match[2]));
    }
  }

  const wired = pages.get("Pages wired down");
  const anonymous = pages.get("Anonymous pages");
  const purgeable = pages.get("Pages purgeable");
  const compressed = pages.get("Pages occupied by compressor");
  if (
    wired === undefined ||
    anonymous === undefined ||
    purgeable === undefined ||
    compressed === undefined
  ) {
    return null;
  }

  const used = (wired + Math.max(0, anonymous - purgeable) + compressed) * pageSize;
  return { free: Math.max(0, total - used), total };
}

/**
 * Linux `/proc/meminfo`. `MemAvailable` (kernel 3.14+) is the kernel's own
 * estimate of what can be claimed without swapping; older kernels get the
 * classic free + buffers + cache approximation. Older libuv builds backed
 * `os.freemem()` with `MemFree`, which has the same cache blindness as macOS.
 */
export function memoryFromMeminfo(contents: string, total: number): MemorySample | null {
  const fields = new Map<string, number>();
  for (const line of contents.split("\n")) {
    const match = /^(\w+):\s+(\d+)\s*kB$/u.exec(line.trim());
    if (match) {
      fields.set(match[1], Number(match[2]) * 1024);
    }
  }

  const available = fields.get("MemAvailable");
  if (available !== undefined) {
    return { free: Math.min(total, available), total };
  }

  const free = fields.get("MemFree");
  if (free === undefined) {
    return null;
  }
  const buffers = fields.get("Buffers") ?? 0;
  const cached = fields.get("Cached") ?? 0;
  const reclaimable = fields.get("SReclaimable") ?? 0;
  return { free: Math.min(total, free + buffers + cached + reclaimable), total };
}

const execFileAsync = promisify(execFile);

/**
 * Memory the way the platform's own monitor reports it. Windows' `freemem()`
 * already comes from `GlobalMemoryStatusEx`, which counts standby cache as
 * available, so it needs no help. Any failure — missing binary, timeout,
 * unparseable output — degrades to `freemem()` rather than to no reading.
 */
export function createMemoryReader(
  platform: NodeJS.Platform = process.platform,
): () => Promise<MemorySample> {
  const fallback = (): MemorySample => ({ free: freemem(), total: totalmem() });

  if (platform === "darwin") {
    return async () => {
      try {
        const { stdout } = await execFileAsync("vm_stat", [], { timeout: 1_000 });
        return memoryFromVmStat(stdout, totalmem()) ?? fallback();
      } catch {
        return fallback();
      }
    };
  }

  if (platform === "linux") {
    return async () => {
      try {
        const contents = await readFile("/proc/meminfo", "utf8");
        return memoryFromMeminfo(contents, totalmem()) ?? fallback();
      } catch {
        return fallback();
      }
    };
  }

  return async () => fallback();
}

export interface ResourceUsageDeps {
  sampleCpu?: () => CpuTimesSample;
  readMemory?: () => MemorySample | Promise<MemorySample>;
  readDisk?: () => Promise<DiskUsage | null>;
  now?: () => number;
}

/**
 * Reader over the whole machine — not this process: the sidebar meter answers
 * "how loaded is my computer", so it uses host counters — `node:os`,
 * `statfs`, and each platform's own memory accounting — instead of Electron's
 * process metrics.
 *
 * CPU only exists as a delta, so each call reports the window since the
 * previous one. The first call has no window and falls back to the since-boot
 * average, which a zero baseline over cumulative counters gives for free.
 */
export function createResourceUsageReader({
  sampleCpu = () => sampleCpuTimes(),
  readMemory = createMemoryReader(),
  // The home volume: where the agent sessions, repos and caches actually land.
  readDisk = () => statfsDisk(homedir()),
  now = Date.now,
}: ResourceUsageDeps = {}): () => Promise<ResourceUsage> {
  let previous: CpuTimesSample = { idle: 0, total: 0 };
  // A failed read is cached too, so an unreachable volume is not retried on
  // every poll.
  let disk: { at: number; value: DiskUsage | null } | null = null;

  return async () => {
    const current = sampleCpu();
    const cpuPercent = cpuPercentBetween(previous, current);
    previous = current;

    const { free, total } = await readMemory();

    if (!disk || now() - disk.at >= DISK_TTL_MS) {
      disk = { at: now(), value: await readDisk() };
    }

    return {
      cpuPercent,
      memory: usageSample(total - free, total),
      disk: disk.value,
    };
  };
}

export const getResourceUsage = createResourceUsageReader();
