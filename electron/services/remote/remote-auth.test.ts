import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LAST_SEEN_PERSIST_MS,
  MAX_PIN_FAILURES,
  PIN_LOCK_MS,
  RemoteAuth,
  generatePin,
  hashToken,
  isAllowedRemoteAddress,
  sanitizeDeviceName,
  writeFileAtomic,
} from "./remote-auth";

const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ht-remote-auth-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeAuth(clock = { now: 1_700_000_000_000 }) {
  const dir = await makeDir();
  const devicesPath = join(dir, "remote", "devices.json");
  const logs: string[] = [];
  const auth = new RemoteAuth({ devicesPath, now: () => clock.now, log: (event) => logs.push(event) });
  cleanup.push(() => auth.flush());
  await auth.load();
  return { auth, devicesPath, dir, clock, logs };
}

const wrongPin = (pin: string) => (pin === "000000" ? "000001" : "000000");

describe("isAllowedRemoteAddress", () => {
  it.each([
    "127.0.0.1",
    "127.8.9.10",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.0.10",
    "169.254.10.20",
    "100.64.0.1",
    "100.127.255.255",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%12",
    "febf::1",
    "::ffff:192.168.1.20",
    "::FFFF:10.1.2.3",
    "[::1]",
  ])("allows %s", (address) => {
    expect(isAllowedRemoteAddress(address)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "8.8.8.8",
    "172.15.255.255",
    "172.32.0.1",
    "192.169.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "11.0.0.1",
    "0.0.0.0",
    "2804:7c0:2a2c:eb00::1",
    "2001:db8::1",
    "fec0::1",
    "::",
    "::ffff:8.8.8.8",
    "localhost",
    "192.168.1",
  ])("refuses %s", (address) => {
    expect(isAllowedRemoteAddress(address)).toBe(false);
  });
});

describe("helpers", () => {
  it("makes six-digit PINs", () => {
    for (let index = 0; index < 50; index += 1) expect(generatePin()).toMatch(/^\d{6}$/u);
  });

  it("cleans device names", () => {
    expect(sanitizeDeviceName("  iPhone\u0000 de\n Ana  ")).toBe("iPhone de Ana");
    expect(sanitizeDeviceName("x".repeat(200))).toHaveLength(64);
    expect(sanitizeDeviceName(42)).toBe("");
  });

  it("writes atomically without leaving temp files", async () => {
    const dir = await makeDir();
    const file = join(dir, "nested", "a.json");
    await writeFileAtomic(file, "one");
    await writeFileAtomic(file, "two");
    expect(await readFile(file, "utf8")).toBe("two");
    expect(await readdir(join(dir, "nested"))).toEqual(["a.json"]);
  });
});

describe("RemoteAuth", () => {
  it("pairs with the right PIN, stores only the token hash and rotates the PIN", async () => {
    const { auth, devicesPath } = await makeAuth();
    const changes: string[] = [];
    auth.onChange((change) => changes.push(change));
    const pin = auth.pin;
    const result = await auth.pair(pin, " Pixel 8 · Chrome ", "192.168.0.20");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.device.name).toBe("Pixel 8 · Chrome");
    expect(auth.pin).not.toBe(pin);
    expect(changes).toEqual(["devices", "pin"]);

    const stored = await readFile(devicesPath, "utf8");
    expect(stored).not.toContain(result.token);
    expect(JSON.parse(stored).devices[0]).toMatchObject({
      id: result.device.id,
      name: "Pixel 8 · Chrome",
      tokenHash: hashToken(result.token),
    });

    expect(auth.authenticate(result.token)).toMatchObject({ id: result.device.id });
    expect(auth.authenticate("x".repeat(43))).toBeNull();
    expect(auth.authenticate("short")).toBeNull();
    expect(auth.authenticate(undefined)).toBeNull();
  });

  it("refuses the old PIN after a pairing", async () => {
    const { auth } = await makeAuth();
    const pin = auth.pin;
    await auth.pair(pin, "a", "192.168.0.20");
    expect(await auth.pair(pin, "b", "192.168.0.21")).toEqual({ ok: false, reason: "invalid_pin" });
  });

  it("refuses malformed PINs", async () => {
    const { auth } = await makeAuth();
    for (const guess of [undefined, Number(auth.pin), "", auth.pin.slice(1), `${auth.pin}0`]) {
      expect(await auth.pair(guess, "x", "192.168.0.9")).toMatchObject({ ok: false });
    }
    // Spaces typed around or inside the right PIN are fine.
    const other = await makeAuth();
    const spaced = ` ${other.auth.pin.slice(0, 3)} ${other.auth.pin.slice(3)} `;
    expect((await other.auth.pair(spaced, "x", "10.0.0.1")).ok).toBe(true);
  });

  it("locks an address after five wrong PINs for ten minutes", async () => {
    const { auth, clock, logs } = await makeAuth();
    const address = "192.168.0.50";
    for (let index = 0; index < MAX_PIN_FAILURES - 1; index += 1) {
      expect(await auth.pair(wrongPin(auth.pin), "x", address)).toEqual({ ok: false, reason: "invalid_pin" });
    }
    expect(await auth.pair(wrongPin(auth.pin), "x", address)).toEqual({
      ok: false,
      reason: "locked",
      retryAfterMs: PIN_LOCK_MS,
    });
    expect(logs).toContain("remote.pair_locked");
    // Even the right PIN is refused while locked.
    clock.now += 60_000;
    expect(await auth.pair(auth.pin, "x", address)).toEqual({
      ok: false,
      reason: "locked",
      retryAfterMs: PIN_LOCK_MS - 60_000,
    });
    clock.now += PIN_LOCK_MS;
    expect((await auth.pair(auth.pin, "x", address)).ok).toBe(true);
  });

  it("locks everyone after five wrong PINs from different addresses", async () => {
    const { auth } = await makeAuth();
    for (let index = 0; index < MAX_PIN_FAILURES; index += 1) {
      await auth.pair(wrongPin(auth.pin), "x", `10.0.0.${index + 1}`);
    }
    expect(await auth.pair(auth.pin, "x", "10.0.0.99")).toMatchObject({ ok: false, reason: "locked" });
    // A new PIN from the desktop lifts the overall lock.
    auth.regeneratePin();
    expect((await auth.pair(auth.pin, "x", "10.0.0.99")).ok).toBe(true);
  });

  it("keeps a per-address lock across a new PIN", async () => {
    const { auth } = await makeAuth();
    for (let index = 0; index < MAX_PIN_FAILURES; index += 1) {
      await auth.pair(wrongPin(auth.pin), "x", "10.0.0.7");
    }
    auth.regeneratePin();
    expect(await auth.pair(auth.pin, "x", "10.0.0.7")).toMatchObject({ ok: false, reason: "locked" });
    expect((await auth.pair(auth.pin, "x", "10.0.0.8")).ok).toBe(true);
  });

  it("forgets failures older than the window", async () => {
    const { auth, clock } = await makeAuth();
    for (let index = 0; index < MAX_PIN_FAILURES - 1; index += 1) {
      await auth.pair(wrongPin(auth.pin), "x", "10.0.0.7");
    }
    clock.now += 10 * 60_000 + 1;
    expect(await auth.pair(wrongPin(auth.pin), "x", "10.0.0.7")).toEqual({ ok: false, reason: "invalid_pin" });
  });

  it("reloads devices from disk and survives a corrupt file", async () => {
    const { auth, devicesPath, clock } = await makeAuth();
    const result = await auth.pair(auth.pin, "Tablet", "10.0.0.2");
    if (!result.ok) throw new Error("pairing failed");
    const again = new RemoteAuth({ devicesPath, now: () => clock.now });
    await again.load();
    expect(again.devices()).toEqual([result.device]);
    expect(again.authenticate(result.token)?.id).toBe(result.device.id);

    await writeFile(devicesPath, "{not json", "utf8");
    const broken = new RemoteAuth({ devicesPath, now: () => clock.now, log: () => undefined });
    await broken.load();
    expect(broken.devices()).toEqual([]);
  });

  it("throttles lastSeenAt writes", async () => {
    const { auth, devicesPath, clock } = await makeAuth();
    const result = await auth.pair(auth.pin, "Phone", "10.0.0.2");
    if (!result.ok) throw new Error("pairing failed");
    const pairedAt = result.device.pairedAt;
    clock.now += 1_000;
    expect(auth.authenticate(result.token)?.lastSeenAt).toBe(pairedAt + 1_000);
    await auth.flush();
    // flush writes what is pending.
    expect(JSON.parse(await readFile(devicesPath, "utf8")).devices[0].lastSeenAt).toBe(pairedAt + 1_000);

    clock.now += 1_000;
    auth.authenticate(result.token);
    // Not due yet: still the previous value on disk.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(JSON.parse(await readFile(devicesPath, "utf8")).devices[0].lastSeenAt).toBe(pairedAt + 1_000);

    clock.now += LAST_SEEN_PERSIST_MS;
    auth.authenticate(result.token);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(JSON.parse(await readFile(devicesPath, "utf8")).devices[0].lastSeenAt).toBe(clock.now);
  });

  it("revokes one device or all of them", async () => {
    const { auth, devicesPath } = await makeAuth();
    const first = await auth.pair(auth.pin, "One", "10.0.0.2");
    const second = await auth.pair(auth.pin, "Two", "10.0.0.3");
    const third = await auth.pair(auth.pin, "Three", "10.0.0.4");
    if (!first.ok || !second.ok || !third.ok) throw new Error("pairing failed");
    expect(auth.devices().map((device) => device.name)).toEqual(["One", "Two", "Three"]);

    expect(await auth.revoke(first.device.id)).toBe(true);
    expect(await auth.revoke(first.device.id)).toBe(false);
    expect(auth.authenticate(first.token)).toBeNull();
    expect(auth.authenticate(second.token)).not.toBeNull();

    expect((await auth.revokeAll()).sort()).toEqual([second.device.id, third.device.id].sort());
    expect(auth.devices()).toEqual([]);
    expect(JSON.parse(await readFile(devicesPath, "utf8")).devices).toEqual([]);
  });
});
