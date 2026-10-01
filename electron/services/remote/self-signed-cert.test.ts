import { X509Certificate, createPrivateKey } from "node:crypto";
import { createServer, get } from "node:https";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  derObjectIdentifier,
  derTime,
  derUnsignedInteger,
  generateSelfSignedCert,
  ipAddressBytes,
  normalizeDnsNames,
} from "./self-signed-cert";

const DAY_MS = 24 * 60 * 60_000;

describe("DER helpers", () => {
  it("encodes OIDs with multi-byte arcs", () => {
    // 1.2.840.10045.4.3.2 — ecdsa-with-SHA256
    expect(derObjectIdentifier("1.2.840.10045.4.3.2").toString("hex")).toBe("06082a8648ce3d040302");
  });

  it("encodes integers minimally and positive", () => {
    expect(derUnsignedInteger(Buffer.from([0, 0, 5])).toString("hex")).toBe("020105");
    expect(derUnsignedInteger(Buffer.from([0x80])).toString("hex")).toBe("02020080");
    expect(derUnsignedInteger(Buffer.from([])).toString("hex")).toBe("020100");
  });

  it("uses UTCTime before 2050 and GeneralizedTime after", () => {
    expect(derTime(Date.UTC(2026, 9, 1, 12, 30, 5)).toString("ascii").slice(2)).toBe("261001123005Z");
    expect(derTime(Date.UTC(2026, 9, 1))[0]).toBe(0x17);
    const later = derTime(Date.UTC(2051, 0, 2, 3, 4, 5));
    expect(later[0]).toBe(0x18);
    expect(later.subarray(2).toString("ascii")).toBe("20510102030405Z");
  });

  it("turns IP literals into SAN bytes", () => {
    expect(ipAddressBytes("192.168.0.10")?.toString("hex")).toBe("c0a8000a");
    expect(ipAddressBytes("::1")?.toString("hex")).toBe(`${"00".repeat(15)}01`);
    expect(ipAddressBytes("fe80::1%12")?.toString("hex")).toBe(`fe80${"00".repeat(13)}01`);
    expect(ipAddressBytes("::ffff:10.0.0.1")?.toString("hex")).toBe(`${"00".repeat(10)}ffff0a000001`);
    expect(ipAddressBytes("1:2:3:4:5:6:7:8")?.toString("hex")).toBe("00010002000300040005000600070008");
    expect(ipAddressBytes("localhost")).toBeNull();
    expect(ipAddressBytes("999.1.1.1")).toBeNull();
  });

  it("keeps only valid DNS names", () => {
    expect(normalizeDnsNames(["LocalHost", "my pc", "Desk_1", "desk-1.local.", "localhost", "1.2.3.4"])).toEqual([
      "localhost",
      "desk-1.local",
    ]);
  });
});

describe("generateSelfSignedCert", () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0);
  const generated = generateSelfSignedCert({
    dnsNames: ["localhost", "Matheus", "matheus.local"],
    ipAddresses: ["127.0.0.1", "192.168.16.148", "::1", "not an ip"],
    now,
  });
  const cert = new X509Certificate(generated.certPem);

  it("parses, is self-signed and verifies against its own key", () => {
    expect(cert.subject).toBe("CN=Head Terminal");
    expect(cert.issuer).toBe("CN=Head Terminal");
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.checkPrivateKey(createPrivateKey(generated.keyPem))).toBe(true);
    expect(cert.publicKey.asymmetricKeyType).toBe("ec");
    expect(cert.ca).toBe(false);
  });

  it("is valid from a day ago for a year", () => {
    expect(Date.parse(cert.validFrom)).toBe(now - DAY_MS);
    expect(Date.parse(cert.validTo)).toBe(now + 365 * DAY_MS);
    expect(generated.notAfter).toBe(now + 365 * DAY_MS);
  });

  it("lists the names and addresses in the subjectAltName", () => {
    expect(generated.dnsNames).toEqual(["localhost", "matheus", "matheus.local"]);
    expect(generated.ipAddresses).toEqual(["127.0.0.1", "192.168.16.148", "::1"]);
    expect(cert.subjectAltName).toContain("DNS:localhost");
    expect(cert.subjectAltName).toContain("IP Address:192.168.16.148");
    expect(cert.checkIP("192.168.16.148")).toBe("192.168.16.148");
    expect(cert.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(cert.checkIP("::1")).toBe("::1");
    expect(cert.checkIP("192.168.16.149")).toBeUndefined();
    expect(cert.checkHost("matheus.local")).toBe("matheus.local");
    expect(cert.checkHost("example.com")).toBeUndefined();
    // Node's `keyUsage` is the extended key usage.
    expect(cert.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
  });

  it("uses a fresh positive serial each time", () => {
    const other = new X509Certificate(
      generateSelfSignedCert({ dnsNames: ["localhost"], ipAddresses: [], now }).certPem,
    );
    expect(other.serialNumber).not.toBe(cert.serialNumber);
    expect(Number.parseInt(cert.serialNumber[0], 16)).toBeLessThan(8);
  });

  it("refuses a certificate with no name", () => {
    expect(() => generateSelfSignedCert({ dnsNames: ["bad name"], ipAddresses: ["x"] })).toThrow();
  });

  it("completes a real TLS handshake trusted only through the certificate itself", async () => {
    const live = generateSelfSignedCert({ dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"] });
    const server = createServer({ key: live.keyPem, cert: live.certPem }, (_req, res) => {
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const fetchWith = (ca: string) =>
        new Promise<string>((resolve, reject) => {
          get({ host: "127.0.0.1", port, path: "/", ca, agent: false }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve(body));
          }).on("error", reject);
        });
      await expect(fetchWith(live.certPem)).resolves.toBe("ok");
      // A different self-signed certificate is not trusted for it.
      await expect(fetchWith(generated.certPem)).rejects.toThrow();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
