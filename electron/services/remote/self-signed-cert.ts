import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

/**
 * A self-signed X.509 certificate for the phone remote, built by hand in DER
 * so the app needs no dependency for it. The phone's browser only grants the
 * microphone (getUserMedia / MediaRecorder) to a secure context, so the
 * remote is served over HTTPS even on the LAN; the user accepts the
 * certificate warning once per phone.
 *
 * ECDSA P-256 + SHA-256, v3, with the extensions browsers insist on for a
 * server certificate: subjectAltName (names are never read from the CN any
 * more), basicConstraints CA:FALSE, keyUsage digitalSignature and
 * extKeyUsage serverAuth.
 */

export interface SelfSignedCertOptions {
  /** Defaults to "Head Terminal". */
  commonName?: string;
  dnsNames: readonly string[];
  /** IPv4 or IPv6 literals; anything else is ignored. */
  ipAddresses: readonly string[];
  /** Epoch ms the validity is counted from. */
  now?: number;
  /** Defaults to 365. Apple refuses TLS certificates valid for > 825 days. */
  validityDays?: number;
}

export interface SelfSignedCert {
  certPem: string;
  /** PKCS#8 PEM. */
  keyPem: string;
  /** Epoch ms, second precision. */
  notAfter: number;
  /** What the subjectAltName lists, normalized. */
  ipAddresses: string[];
  dnsNames: string[];
}

const DAY_MS = 24 * 60 * 60_000;

const OID = {
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;

// ---------------------------------------------------------------- DER

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Tag-length-value. */
export function derTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const derSequence = (...items: Buffer[]) => derTlv(0x30, Buffer.concat(items));
const derSet = (...items: Buffer[]) => derTlv(0x31, Buffer.concat(items));
const derOctetString = (content: Buffer) => derTlv(0x04, content);
const derBoolean = (value: boolean) => derTlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const derUtf8String = (value: string) => derTlv(0x0c, Buffer.from(value, "utf8"));
/** Constructed, context-specific [n] — EXPLICIT tagging. */
const derExplicit = (tagNumber: number, content: Buffer) => derTlv(0xa0 | tagNumber, content);
/** Primitive, context-specific [n] — IMPLICIT tagging of a primitive type. */
const derImplicit = (tagNumber: number, content: Buffer) => derTlv(0x80 | tagNumber, content);

/** A non-negative INTEGER from big-endian magnitude bytes, minimally encoded. */
export function derUnsignedInteger(magnitude: Buffer): Buffer {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start += 1;
  let bytes = magnitude.subarray(start);
  if (bytes.length === 0) bytes = Buffer.from([0]);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return derTlv(0x02, bytes);
}

/** BIT STRING with no unused bits. */
function derBitString(content: Buffer, unusedBits = 0): Buffer {
  return derTlv(0x03, Buffer.concat([Buffer.from([unusedBits]), content]));
}

export function derObjectIdentifier(oid: string): Buffer {
  const arcs = oid.split(".").map((arc) => Number.parseInt(arc, 10));
  if (arcs.length < 2 || arcs.some((arc) => !Number.isSafeInteger(arc) || arc < 0)) {
    throw new TypeError(`invalid OID: ${oid}`);
  }
  const bytes: number[] = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [arc & 0x7f];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) {
      chunk.unshift(0x80 | (rest & 0x7f));
    }
    bytes.push(...chunk);
  }
  return derTlv(0x06, Buffer.from(bytes));
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050. */
export function derTime(epochMs: number): Buffer {
  const date = new Date(epochMs);
  const year = date.getUTCFullYear();
  const rest =
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  if (year >= 1950 && year < 2050) {
    return derTlv(0x17, Buffer.from(pad(year % 100) + rest, "ascii"));
  }
  return derTlv(0x18, Buffer.from(pad(year, 4) + rest, "ascii"));
}

// ---------------------------------------------------------------- addresses

/** The 4 or 16 bytes of an IP literal, or null when it is not one. */
export function ipAddressBytes(address: string): Buffer | null {
  const ip = address.replace(/^\[|\]$/gu, "").replace(/%.*$/u, "");
  if (isIPv4(ip)) return Buffer.from(ip.split(".").map((part) => Number.parseInt(part, 10)));
  if (!isIPv6(ip)) return null;
  let text = ip;
  const tail: number[] = [];
  // An embedded IPv4 (::ffff:1.2.3.4) is the last 32 bits.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text);
  if (v4) {
    const parts = v4[1].split(".").map((part) => Number.parseInt(part, 10));
    tail.push((parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]);
    text = text.slice(0, -v4[1].length);
    if (text.endsWith(":") && !text.endsWith("::")) text = text.slice(0, -1);
  }
  const [head, rest] = text.includes("::") ? text.split("::") : [text, undefined];
  const parse = (part: string | undefined) =>
    part ? part.split(":").filter(Boolean).map((group) => Number.parseInt(group, 16)) : [];
  const left = parse(head);
  const right = [...parse(rest), ...tail];
  const missing = 8 - left.length - right.length;
  const groups = rest === undefined ? [...left, ...right] : [...left, ...Array(missing).fill(0), ...right];
  if (groups.length !== 8) return null;
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(group, index * 2));
  return bytes;
}

const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

/** Lowercased host names a certificate can carry; anything else is dropped. */
export function normalizeDnsNames(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const value = name.trim().toLowerCase().replace(/\.$/u, "");
    if (DNS_NAME.test(value) && !isIPv4(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

function normalizeIpAddresses(addresses: readonly string[]): string[] {
  const out: string[] = [];
  for (const address of addresses) {
    const value = address.trim().replace(/^\[|\]$/gu, "").replace(/%.*$/u, "").toLowerCase();
    if (ipAddressBytes(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

// ---------------------------------------------------------------- certificate

function distinguishedName(commonName: string): Buffer {
  return derSequence(derSet(derSequence(derObjectIdentifier(OID.commonName), derUtf8String(commonName))));
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return derSequence(
    derObjectIdentifier(oid),
    ...(critical ? [derBoolean(true)] : []),
    derOctetString(value),
  );
}

/** A positive 16-byte serial (RFC 5280 caps it at 20 octets). */
function randomSerial(): Buffer {
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) || 0x01;
  return serial;
}

function toPem(label: string, der: Buffer): string {
  const base64 = der.toString("base64").replace(/(.{64})/gu, "$1\n").replace(/\n$/u, "");
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

export function generateSelfSignedCert(options: SelfSignedCertOptions): SelfSignedCert {
  const commonName = options.commonName ?? "Head Terminal";
  const now = options.now ?? Date.now();
  const validityDays = options.validityDays ?? 365;
  const dnsNames = normalizeDnsNames(options.dnsNames);
  const ipAddresses = normalizeIpAddresses(options.ipAddresses);
  if (dnsNames.length === 0 && ipAddresses.length === 0) {
    throw new TypeError("a certificate needs at least one name");
  }
  // Second precision: what the certificate can say is what we report.
  const notBefore = Math.floor((now - DAY_MS) / 1000) * 1000;
  const notAfter = Math.floor((now + validityDays * DAY_MS) / 1000) * 1000;

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const signatureAlgorithm = derSequence(derObjectIdentifier(OID.ecdsaWithSha256));
  const name = distinguishedName(commonName);

  const altNames = derSequence(
    ...dnsNames.map((dns) => derImplicit(2, Buffer.from(dns, "ascii"))),
    ...ipAddresses.map((ip) => derImplicit(7, ipAddressBytes(ip)!)),
  );
  const extensions = derSequence(
    extension(OID.subjectAltName, false, altNames),
    // CA:FALSE is the DEFAULT, so the sequence is empty.
    extension(OID.basicConstraints, true, derSequence()),
    // digitalSignature is bit 0: one byte 0x80 with 7 unused bits.
    extension(OID.keyUsage, true, derBitString(Buffer.from([0x80]), 7)),
    extension(OID.extKeyUsage, false, derSequence(derObjectIdentifier(OID.serverAuth))),
  );

  const tbsCertificate = derSequence(
    derExplicit(0, derUnsignedInteger(Buffer.from([2]))), // v3
    derUnsignedInteger(randomSerial()),
    signatureAlgorithm,
    name,
    derSequence(derTime(notBefore), derTime(notAfter)),
    name,
    spki,
    derExplicit(3, extensions),
  );
  // ECDSA signatures come out DER-encoded (dsaEncoding "der" is the default).
  const signature = sign("sha256", tbsCertificate, privateKey);
  const certificate = derSequence(tbsCertificate, signatureAlgorithm, derBitString(signature));

  return {
    certPem: toPem("CERTIFICATE", certificate),
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    notAfter,
    ipAddresses,
    dnsNames,
  };
}
