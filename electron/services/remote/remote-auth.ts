import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIPv4, isIPv6 } from "node:net";
import path from "node:path";

import type { RemoteDevice } from "../../../src/types/remote";

/**
 * Who may drive the remote: phones paired with the six-digit PIN Settings
 * shows. A pairing trades the PIN for a long random token that lives only in
 * the phone's cookie; the disk keeps its SHA-256, so a copy of devices.json
 * cannot be replayed. The PIN changes after every pairing, and guessing it
 * is rate limited both per address and overall.
 */

export const PIN_LENGTH = 6;
export const MAX_PIN_FAILURES = 5;
export const PIN_FAILURE_WINDOW_MS = 10 * 60_000;
export const PIN_LOCK_MS = 10 * 60_000;
/** `lastSeenAt` is kept in memory on every request, written at most this often. */
export const LAST_SEEN_PERSIST_MS = 5 * 60_000;
export const MAX_DEVICE_NAME_LENGTH = 64;
/** 32 random bytes, base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DEVICE_ID_PATTERN = /^[0-9a-f]{16}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

// ---------------------------------------------------------------- addresses

function ipv4Value(address: string): number | null {
  if (!isIPv4(address)) return null;
  return address.split(".").reduce((value, part) => value * 256 + Number.parseInt(part, 10), 0);
}

function inIpv4Range(value: number, base: string, bits: number): boolean {
  const start = ipv4Value(base)!;
  const size = 2 ** (32 - bits);
  return value >= start && value < start + size;
}

/**
 * Only the machine itself and the networks a home or a tailnet uses:
 * loopback, RFC 1918, link-local, CGNAT (Tailscale) and their IPv6
 * counterparts (::1, ULA fc00::/7, link-local fe80::/10). Anything that
 * could have come from the internet is refused before a byte is answered.
 */
export function isAllowedRemoteAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  let ip = address.trim().replace(/^\[|\]$/gu, "").replace(/%.*$/u, "").toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(ip);
  if (mapped) ip = mapped[1];
  const v4 = ipv4Value(ip);
  if (v4 !== null) {
    return (
      inIpv4Range(v4, "127.0.0.0", 8) ||
      inIpv4Range(v4, "10.0.0.0", 8) ||
      inIpv4Range(v4, "172.16.0.0", 12) ||
      inIpv4Range(v4, "192.168.0.0", 16) ||
      inIpv4Range(v4, "169.254.0.0", 16) ||
      inIpv4Range(v4, "100.64.0.0", 10)
    );
  }
  if (!isIPv6(ip)) return false;
  if (ip === "::1") return true;
  // First group decides: fc00::/7 and fe80::/10. A literal that starts with
  // "::" has a zero first group.
  const first = ip.startsWith("::") ? 0 : Number.parseInt(ip.split(":")[0], 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

// ---------------------------------------------------------------- helpers

export function generatePin(): string {
  return String(randomInt(0, 10 ** PIN_LENGTH)).padStart(PIN_LENGTH, "0");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** What a phone may call itself: printable, trimmed, bounded. */
export function sanitizeDeviceName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_DEVICE_NAME_LENGTH)
    .trim();
}

/** tmp + rename, so a crash never leaves half a file. */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
  try {
    // Windows: an antivirus or indexer briefly holding the target makes the
    // rename fail with EPERM/EBUSY; it is free again a moment later.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tmp, filePath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------- auth

interface DeviceRecord extends RemoteDevice {
  tokenHash: string;
}

interface DevicesFile {
  version: 1;
  devices: DeviceRecord[];
}

export type PairResult =
  | { ok: true; token: string; device: RemoteDevice }
  | { ok: false; reason: "invalid_pin" }
  | { ok: false; reason: "locked"; retryAfterMs: number };

interface FailureState {
  failures: number[];
  lockedUntil: number;
}

export interface RemoteAuthOptions {
  /** `<userData>/remote/devices.json`. */
  devicesPath: string;
  now?: () => number;
  log?: (event: string, meta?: Record<string, unknown>) => void;
}

export type RemoteAuthChange = "pin" | "devices";

export class RemoteAuth {
  private readonly devicesPath: string;
  private readonly now: () => number;
  private readonly log: (event: string, meta?: Record<string, unknown>) => void;
  private readonly byHash = new Map<string, DeviceRecord>();
  /** lastSeenAt of each device as last written. */
  private readonly persistedSeen = new Map<string, number>();
  private readonly global: FailureState = { failures: [], lockedUntil: 0 };
  private readonly perAddress = new Map<string, FailureState>();
  private readonly listeners = new Set<(change: RemoteAuthChange) => void>();
  private currentPin = generatePin();
  private writeChain: Promise<void> = Promise.resolve();
  private seenTimer: NodeJS.Timeout | null = null;

  constructor(options: RemoteAuthOptions) {
    this.devicesPath = options.devicesPath;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  /** Reads devices.json. A missing or unreadable file means no devices. */
  async load(): Promise<void> {
    this.byHash.clear();
    this.persistedSeen.clear();
    let raw: string;
    try {
      raw = await readFile(this.devicesPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log("remote.devices_read_failed", { error: String(error) });
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<DevicesFile>;
      for (const entry of Array.isArray(parsed.devices) ? parsed.devices : []) {
        const record = parseDeviceRecord(entry);
        if (!record) continue;
        this.byHash.set(record.tokenHash, record);
        this.persistedSeen.set(record.id, record.lastSeenAt);
      }
    } catch (error) {
      this.log("remote.devices_read_failed", { error: String(error) });
    }
  }

  onChange(listener: (change: RemoteAuthChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get pin(): string {
    return this.currentPin;
  }

  /**
   * New PIN. Asked for on the desktop, so it also lifts the overall lock: a
   * phone on the LAN guessing wrong must not keep the owner from pairing.
   * Per-address locks stay.
   */
  regeneratePin(): string {
    this.currentPin = generatePin();
    this.global.failures = [];
    this.global.lockedUntil = 0;
    this.emit("pin");
    return this.currentPin;
  }

  /** Remaining lock, ms; 0 when `address` may try a PIN now. */
  lockRemaining(address: string): number {
    const now = this.now();
    const local = this.perAddress.get(address)?.lockedUntil ?? 0;
    return Math.max(0, this.global.lockedUntil - now, local - now);
  }

  async pair(pin: unknown, name: unknown, address: string): Promise<PairResult> {
    const locked = this.lockRemaining(address);
    if (locked > 0) return { ok: false, reason: "locked", retryAfterMs: locked };

    if (!this.pinMatches(pin)) {
      const lockedNow = this.recordFailure(address);
      this.log("remote.pair_failed", { address, locked: lockedNow > 0 });
      return lockedNow > 0
        ? { ok: false, reason: "locked", retryAfterMs: lockedNow }
        : { ok: false, reason: "invalid_pin" };
    }

    this.perAddress.delete(address);
    this.global.failures = [];
    const now = this.now();
    const token = randomBytes(32).toString("base64url");
    const record: DeviceRecord = {
      id: this.newDeviceId(),
      name: sanitizeDeviceName(name) || "Celular",
      pairedAt: now,
      lastSeenAt: now,
      tokenHash: hashToken(token),
    };
    this.byHash.set(record.tokenHash, record);
    this.persistedSeen.set(record.id, now);
    await this.persist();
    // A PIN is good for one phone.
    this.currentPin = generatePin();
    this.log("remote.paired", { deviceId: record.id, name: record.name, address });
    this.emit("devices");
    this.emit("pin");
    return { ok: true, token, device: publicDevice(record) };
  }

  /** The device a cookie token belongs to, or null. Marks it as seen. */
  authenticate(token: string | undefined | null): RemoteDevice | null {
    if (!token || !TOKEN_PATTERN.test(token)) return null;
    const record = this.byHash.get(hashToken(token));
    if (!record) return null;
    const now = this.now();
    record.lastSeenAt = now;
    if (now - (this.persistedSeen.get(record.id) ?? 0) >= LAST_SEEN_PERSIST_MS) {
      this.scheduleSeenWrite();
    }
    return publicDevice(record);
  }

  /** The device id a token belongs to, without touching lastSeenAt. */
  deviceIdForToken(token: string | undefined | null): string | null {
    if (!token || !TOKEN_PATTERN.test(token)) return null;
    return this.byHash.get(hashToken(token))?.id ?? null;
  }

  hasDevice(id: string): boolean {
    for (const record of this.byHash.values()) if (record.id === id) return true;
    return false;
  }

  devices(): RemoteDevice[] {
    return [...this.byHash.values()]
      .map(publicDevice)
      .sort((left, right) => left.pairedAt - right.pairedAt);
  }

  async revoke(id: string): Promise<boolean> {
    let removed = false;
    for (const [hash, record] of this.byHash) {
      if (record.id !== id) continue;
      this.byHash.delete(hash);
      this.persistedSeen.delete(id);
      removed = true;
    }
    if (!removed) return false;
    await this.persist();
    this.log("remote.revoked", { deviceId: id });
    this.emit("devices");
    return true;
  }

  async revokeAll(): Promise<string[]> {
    const ids = [...this.byHash.values()].map((record) => record.id);
    if (ids.length === 0) return [];
    this.byHash.clear();
    this.persistedSeen.clear();
    await this.persist();
    this.log("remote.revoked_all", { count: ids.length });
    this.emit("devices");
    return ids;
  }

  /** Writes any lastSeenAt still only in memory. */
  async flush(): Promise<void> {
    if (this.seenTimer) {
      clearTimeout(this.seenTimer);
      this.seenTimer = null;
    }
    const dirty = [...this.byHash.values()].some(
      (record) => record.lastSeenAt !== this.persistedSeen.get(record.id),
    );
    if (dirty) await this.persist();
    else await this.writeChain;
  }

  // -------------------------------------------------------------- private

  private pinMatches(candidate: unknown): boolean {
    const value = typeof candidate === "string" ? candidate.replace(/\s+/gu, "") : "";
    const expected = Buffer.from(this.currentPin, "utf8");
    // Same length on both sides, so the comparison itself is constant time;
    // a malformed guess still costs one attempt.
    const given = Buffer.alloc(expected.length);
    Buffer.from(value, "utf8").copy(given, 0, 0, expected.length);
    const sameShape = value.length === PIN_LENGTH && /^\d+$/u.test(value);
    return timingSafeEqual(given, expected) && sameShape;
  }

  /** Counts a wrong PIN; returns the lock it caused, ms, or 0. */
  private recordFailure(address: string): number {
    const now = this.now();
    let local = this.perAddress.get(address);
    if (!local) {
      local = { failures: [], lockedUntil: 0 };
      this.perAddress.set(address, local);
    }
    let locked = 0;
    for (const state of [this.global, local]) {
      state.failures = state.failures.filter((at) => now - at < PIN_FAILURE_WINDOW_MS);
      state.failures.push(now);
      if (state.failures.length >= MAX_PIN_FAILURES) {
        state.failures = [];
        state.lockedUntil = now + PIN_LOCK_MS;
        locked = PIN_LOCK_MS;
      }
    }
    if (locked) this.log("remote.pair_locked", { address, lockMs: locked });
    // Forget addresses that have nothing left to remember.
    for (const [key, state] of this.perAddress) {
      if (state.lockedUntil <= now && state.failures.every((at) => now - at >= PIN_FAILURE_WINDOW_MS)) {
        if (key !== address) this.perAddress.delete(key);
      }
    }
    return locked;
  }

  private newDeviceId(): string {
    for (;;) {
      const id = randomBytes(8).toString("hex");
      if (!this.hasDevice(id)) return id;
    }
  }

  private scheduleSeenWrite(): void {
    if (this.seenTimer) return;
    this.seenTimer = setTimeout(() => {
      this.seenTimer = null;
      void this.persist().then(
        () => this.emit("devices"),
        () => undefined,
      );
    }, 1_000);
    this.seenTimer.unref?.();
  }

  private persist(): Promise<void> {
    const records = [...this.byHash.values()];
    const file: DevicesFile = { version: 1, devices: records.map((record) => ({ ...record })) };
    const content = `${JSON.stringify(file, null, 2)}\n`;
    const write = this.writeChain.then(async () => {
      await writeFileAtomic(this.devicesPath, content);
      for (const record of records) this.persistedSeen.set(record.id, record.lastSeenAt);
    });
    // The chain survives a failed write; the caller still sees the error.
    this.writeChain = write.catch((error: unknown) => {
      this.log("remote.devices_write_failed", { error: String(error) });
    });
    return write;
  }

  private emit(change: RemoteAuthChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}

function publicDevice(record: DeviceRecord): RemoteDevice {
  return { id: record.id, name: record.name, pairedAt: record.pairedAt, lastSeenAt: record.lastSeenAt };
}

function parseDeviceRecord(value: unknown): DeviceRecord | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || !DEVICE_ID_PATTERN.test(entry.id)) return null;
  if (typeof entry.tokenHash !== "string" || !HASH_PATTERN.test(entry.tokenHash)) return null;
  const pairedAt = Number(entry.pairedAt);
  const lastSeenAt = Number(entry.lastSeenAt);
  if (!Number.isFinite(pairedAt) || !Number.isFinite(lastSeenAt)) return null;
  return {
    id: entry.id,
    name: sanitizeDeviceName(entry.name) || "Celular",
    pairedAt,
    lastSeenAt,
    tokenHash: entry.tokenHash,
  };
}
