// QR Code encoder (ISO/IEC 18004, model 2), byte mode only, no dependencies.
//
// Written from scratch, following the structure of Project Nayuki's
// "QR Code generator library" (MIT): pick the smallest version that fits,
// build the bit stream, add Reed–Solomon ECC per block and interleave, draw
// the function patterns, place the codewords in the zigzag order, then try
// the 8 masks and keep the one with the lowest penalty.

export type QrErrorCorrection = "L" | "M" | "Q" | "H";

export interface QrCode {
  /** Modules per side: 21 + 4 * (version - 1). */
  size: number;
  /** modules[y][x]; true = dark. */
  modules: boolean[][];
  /** 1..40. */
  version: number;
  ecc: QrErrorCorrection;
  /** 0..7, the mask that won the penalty evaluation. */
  mask: number;
}

export interface QrEncodeOptions {
  /** Force a mask (0..7) instead of choosing the lowest penalty. Mostly for tests. */
  mask?: number;
}

const MIN_VERSION = 1;
const MAX_VERSION = 40;

// ---------------------------------------------------------------------------
// Tables (ISO/IEC 18004 Table 9), indexed [ecc][version]; index 0 is unused.
// ---------------------------------------------------------------------------

const ECC_ORDER: Record<QrErrorCorrection, number> = { L: 0, M: 1, Q: 2, H: 3 };

/** Format-information bits for each level (note: not in L/M/Q/H order). */
const ECC_FORMAT_BITS: Record<QrErrorCorrection, number> = { L: 1, M: 0, Q: 3, H: 2 };

// prettier-ignore
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  // 0, 1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40
  [-1,  7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
];

// prettier-ignore
const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  // 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4,  4,  4,  4,  4,  6,  6,  6,  6,  7,  8,  8,  9,  9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5,  5,  8,  9,  9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8,  8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
];

// Penalty weights (ISO/IEC 18004 section 7.8.3).
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

// ---------------------------------------------------------------------------
// Capacity helpers
// ---------------------------------------------------------------------------

/**
 * Modules available for data + ECC (including remainder bits) once every
 * function pattern and the format/version areas are excluded.
 */
function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36; // two 6x3 version-information blocks
  }
  return result;
}

/** Data codewords (8-bit) available after removing the ECC codewords. */
function numDataCodewords(version: number, ecc: QrErrorCorrection): number {
  const e = ECC_ORDER[ecc];
  return (
    Math.floor(numRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[e][version] * NUM_ERROR_CORRECTION_BLOCKS[e][version]
  );
}

/** Width of the byte-mode character count field. */
function byteModeCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** Centre coordinates of the alignment patterns (same list for x and y). */
function alignmentPatternPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = version * 4 + 17 - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

// ---------------------------------------------------------------------------
// GF(256) arithmetic and Reed–Solomon (primitive polynomial 0x11d, generator 2)
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  // Doubled so gfMul can skip a "% 255".
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * Generator polynomial (x - 2^0)(x - 2^1)...(x - 2^(degree-1)), as its
 * coefficients from highest to lowest power, without the leading 1.
 */
function reedSolomonDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1; // start with the monomial x^0
  let root = 1;
  for (let i = 0; i < degree; i++) {
    // Multiply the current product by (x - root).
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** Remainder of data(x) * x^degree divided by the generator: the ECC codewords. */
function reedSolomonRemainder(data: ArrayLike<number>, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let j = 0; j < divisor.length; j++) result[j] ^= gfMul(divisor[j], factor);
  }
  return result;
}

// ---------------------------------------------------------------------------
// BCH codes for format and version information
// ---------------------------------------------------------------------------

/** 15-bit format information: 2 bits ECC level + 3 bits mask, BCH(15,5), XOR 0x5412. */
function formatInformationBits(ecc: QrErrorCorrection, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18-bit version information: 6 bits version, BCH(18,6). Only for version >= 7. */
function versionInformationBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

// ---------------------------------------------------------------------------
// Bit stream
// ---------------------------------------------------------------------------

class BitBuffer {
  readonly bits: number[] = [];

  append(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  toBytes(): number[] {
    const bytes = new Array<number>(this.bits.length >>> 3).fill(0);
    this.bits.forEach((b, i) => {
      bytes[i >>> 3] |= b << (7 - (i & 7));
    });
    return bytes;
  }
}

/** Byte-mode segment + terminator + bit padding + 0xEC/0x11 pad codewords. */
function buildDataCodewords(data: Uint8Array, version: number, ecc: QrErrorCorrection): number[] {
  const capacityBits = numDataCodewords(version, ecc) * 8;
  const bb = new BitBuffer();
  bb.append(0b0100, 4); // byte mode indicator
  bb.append(data.length, byteModeCountBits(version));
  for (const b of data) bb.append(b, 8);

  bb.append(0, Math.min(4, capacityBits - bb.bits.length)); // terminator
  bb.append(0, (8 - (bb.bits.length % 8)) % 8); // up to a byte boundary
  for (let pad = 0xec; bb.bits.length < capacityBits; pad ^= 0xec ^ 0x11) bb.append(pad, 8);
  return bb.toBytes();
}

/**
 * Split the data codewords into blocks, append each block's ECC and
 * interleave: data column by column (short blocks have one codeword less),
 * then ECC column by column.
 */
function addEccAndInterleave(data: number[], version: number, ecc: QrErrorCorrection): number[] {
  const e = ECC_ORDER[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e][version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockDataLen = Math.floor(rawCodewords / numBlocks) - blockEccLen;

  const divisor = reedSolomonDivisor(blockEccLen);
  const dataBlocks: number[][] = [];
  const eccBlocks: Uint8Array[] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortBlockDataLen + (i < numShortBlocks ? 0 : 1);
    const block = data.slice(k, k + len);
    k += len;
    dataBlocks.push(block);
    eccBlocks.push(reedSolomonRemainder(block, divisor));
  }

  const result: number[] = [];
  for (let i = 0; i <= shortBlockDataLen; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < blockEccLen; i++) {
    for (const block of eccBlocks) result.push(block[i]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  /** Function modules are never masked nor overwritten by data. */
  readonly isFunction: boolean[][];

  constructor(size: number) {
    this.size = size;
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }

  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
}

function drawFinderPattern(m: Matrix, cx: number, cy: number): void {
  // 7x7 finder plus its 1-module light separator (clipped at the edges).
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= m.size || y < 0 || y >= m.size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      m.setFunction(x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignmentPattern(m: Matrix, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      m.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFormatBits(m: Matrix, ecc: QrErrorCorrection, mask: number): void {
  const bits = formatInformationBits(ecc, mask);
  const size = m.size;

  // Copy 1: around the top-left finder.
  for (let i = 0; i <= 5; i++) m.setFunction(8, i, bit(bits, i));
  m.setFunction(8, 7, bit(bits, 6));
  m.setFunction(8, 8, bit(bits, 7));
  m.setFunction(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) m.setFunction(14 - i, 8, bit(bits, i));

  // Copy 2: split between the top-right and bottom-left finders.
  for (let i = 0; i < 8; i++) m.setFunction(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) m.setFunction(8, size - 15 + i, bit(bits, i));

  m.setFunction(8, size - 8, true); // dark module, always set
}

function drawVersionBits(m: Matrix, version: number): void {
  if (version < 7) return;
  const bits = versionInformationBits(version);
  // Two 6x3 blocks: next to the top-right and bottom-left finders.
  for (let i = 0; i < 18; i++) {
    const dark = bit(bits, i);
    const a = m.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    m.setFunction(a, b, dark);
    m.setFunction(b, a, dark);
  }
}

function drawFunctionPatterns(m: Matrix, version: number, ecc: QrErrorCorrection): void {
  const size = m.size;

  // Timing patterns (row 6 and column 6); finders overwrite their ends.
  for (let i = 0; i < size; i++) {
    m.setFunction(6, i, i % 2 === 0);
    m.setFunction(i, 6, i % 2 === 0);
  }

  drawFinderPattern(m, 3, 3);
  drawFinderPattern(m, size - 4, 3);
  drawFinderPattern(m, 3, size - 4);

  const positions = alignmentPatternPositions(version);
  const n = positions.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // Skip the three that would overlap a finder.
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      drawAlignmentPattern(m, positions[i], positions[j]);
    }
  }

  // Reserve the format area now (real bits are drawn per mask later).
  drawFormatBits(m, ecc, 0);
  drawVersionBits(m, version);
}

/**
 * Place the codewords MSB first in 2-module wide columns, right to left,
 * alternating upward/downward, skipping the vertical timing column (x = 6).
 * Leftover remainder bits stay light.
 */
function drawCodewords(m: Matrix, codewords: number[]): void {
  const size = m.size;
  const totalBits = codewords.length * 8;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (m.isFunction[y][x] || i >= totalBits) continue;
        m.modules[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
        i++;
      }
    }
  }
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** XOR the mask over the data modules. Applying it twice undoes it. */
function applyMask(m: Matrix, mask: number): void {
  const fn = MASKS[mask];
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.isFunction[y][x] && fn(x, y)) m.modules[y][x] = !m.modules[y][x];
    }
  }
}

// ---------------------------------------------------------------------------
// Penalty (ISO/IEC 18004 section 7.8.3)
// ---------------------------------------------------------------------------

/**
 * Tracks the last 7 run lengths of a row/column to spot the 1:1:3:1:1
 * finder-like pattern with 4 light modules on either side (rule 3). The area
 * outside the symbol counts as light, as the quiet zone would be.
 */
class RunHistory {
  private readonly runs = [0, 0, 0, 0, 0, 0, 0];
  private readonly size: number;

  constructor(size: number) {
    this.size = size;
  }

  push(length: number): void {
    if (this.runs[0] === 0) length += this.size; // light border before the first run
    this.runs.pop();
    this.runs.unshift(length);
  }

  /** Number of finder-like patterns ending at the latest light run (0, 1 or 2). */
  countPatterns(): number {
    const r = this.runs;
    const n = r[1];
    const core = n > 0 && r[2] === n && r[3] === n * 3 && r[4] === n && r[5] === n;
    return (core && r[0] >= n * 4 && r[6] >= n ? 1 : 0) + (core && r[6] >= n * 4 && r[0] >= n ? 1 : 0);
  }

  /** Close the line: flush the last run and add the light border after it. */
  terminate(runDark: boolean, runLength: number): number {
    if (runDark) {
      this.push(runLength);
      runLength = 0;
    }
    this.push(runLength + this.size);
    return this.countPatterns();
  }
}

function penaltyScore(m: Matrix): number {
  const size = m.size;
  const mod = m.modules;
  let result = 0;

  // Rules 1 (runs of 5+ same color) and 3 (finder-like patterns), rows then columns.
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let runDark = false;
      let runLength = 0;
      const history = new RunHistory(size);
      for (let b = 0; b < size; b++) {
        const dark = pass === 0 ? mod[a][b] : mod[b][a];
        if (dark === runDark) {
          runLength++;
          if (runLength === 5) result += PENALTY_N1;
          else if (runLength > 5) result++;
        } else {
          history.push(runLength);
          if (!runDark) result += history.countPatterns() * PENALTY_N3;
          runDark = dark;
          runLength = 1;
        }
      }
      result += history.terminate(runDark, runLength) * PENALTY_N3;
    }
  }

  // Rule 2: 2x2 blocks of the same color.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = mod[y][x];
      if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) result += PENALTY_N2;
    }
  }

  // Rule 4: dark/light balance, 10 points per 5% step away from 50%.
  let dark = 0;
  for (const row of mod) for (const cell of row) if (cell) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * PENALTY_N4;

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode `text` (as UTF-8, byte mode) in the smallest QR version that fits at
 * the given error-correction level. Throws if it does not fit in version 40.
 */
export function encodeQr(
  text: string,
  ecc: QrErrorCorrection = "M",
  options: QrEncodeOptions = {},
): QrCode {
  if (!(ecc in ECC_ORDER)) throw new Error(`Invalid QR error correction level: ${String(ecc)}`);
  const forcedMask = options.mask;
  if (forcedMask !== undefined && !(Number.isInteger(forcedMask) && forcedMask >= 0 && forcedMask <= 7)) {
    throw new Error(`Invalid QR mask: ${forcedMask}`);
  }

  const data = new TextEncoder().encode(text);

  let version = MIN_VERSION;
  for (; ; version++) {
    const usedBits = 4 + byteModeCountBits(version) + data.length * 8;
    if (usedBits <= numDataCodewords(version, ecc) * 8) break;
    if (version >= MAX_VERSION) {
      const max = numDataCodewords(MAX_VERSION, ecc) - 3; // 4-bit mode + 16-bit count = 2.5 bytes
      throw new Error(`Text too long for a QR code: ${data.length} bytes (max ${max} at level ${ecc})`);
    }
  }

  const codewords = addEccAndInterleave(buildDataCodewords(data, version, ecc), version, ecc);

  const m = new Matrix(version * 4 + 17);
  drawFunctionPatterns(m, version, ecc);
  drawCodewords(m, codewords);

  let mask = forcedMask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let candidate = 0; candidate < 8; candidate++) {
      applyMask(m, candidate);
      drawFormatBits(m, ecc, candidate);
      const score = penaltyScore(m);
      if (score < best) {
        best = score;
        mask = candidate;
      }
      applyMask(m, candidate); // undo
    }
  }
  applyMask(m, mask);
  drawFormatBits(m, ecc, mask);

  return { size: m.size, modules: m.modules, version, ecc, mask };
}

/**
 * A single SVG path for the dark modules, one rectangle per horizontal run,
 * in module units with `margin` modules of quiet zone. Render with
 * `<svg viewBox={viewBox}><path d={d} fill="currentColor" /></svg>`.
 */
export function qrToSvgPath(qr: QrCode, margin = 4): { viewBox: string; d: string } {
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    const row = qr.modules[y];
    let x = 0;
    while (x < qr.size) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < qr.size && row[x]) x++;
      const len = x - start;
      parts.push(`M${start + margin} ${y + margin}h${len}v1h-${len}z`);
    }
  }
  const side = qr.size + margin * 2;
  return { viewBox: `0 0 ${side} ${side}`, d: parts.join("") };
}
