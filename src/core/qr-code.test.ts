import { describe, expect, it } from "vitest";

import { encodeQr, qrToSvgPath, type QrCode, type QrErrorCorrection } from "./qr-code";

const URL = "https://192.168.0.12:47820/#pair=123456";
const URL60 = "https://192.168.100.200:47820/#pair=123456&host=head-terminal";
const UTF8 = "Olá, ação! São Paulo — coração 🚀";
const TEXT200 = Array.from({ length: 200 }, (_, i) => String.fromCharCode(33 + ((i * 7) % 94))).join("");
const TEXT1000 = Array.from({ length: 1000 }, (_, i) => String.fromCharCode(48 + ((i * 13) % 75))).join("");
const MAX_L = "x".repeat(2953);

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** 32-bit FNV-1a over the matrix as "0/1" rows joined by "\n". */
function fingerprint(qr: QrCode): number {
  const text = qr.modules.map((row) => row.map((d) => (d ? "1" : "0")).join("")).join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function expectFinderAt(qr: QrCode, left: number, top: number): void {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      expect(qr.modules[top + dy][left + dx], `finder (${left + dx}, ${top + dy})`).toBe(ring !== 2);
    }
  }
}

/** The separator: the light ring just outside the finder, clipped to the symbol. */
function expectSeparatorAround(qr: QrCode, left: number, top: number): void {
  for (let i = -1; i <= 7; i++) {
    for (const [x, y] of [
      [left + i, top - 1],
      [left + i, top + 7],
      [left - 1, top + i],
      [left + 7, top + i],
    ]) {
      if (x < 0 || y < 0 || x >= qr.size || y >= qr.size) continue;
      expect(qr.modules[y][x], `separator (${x}, ${y})`).toBe(false);
    }
  }
}

describe("encodeQr", () => {
  it("defaults to level M and reports version, level and mask", () => {
    const qr = encodeQr(URL);
    expect(qr.ecc).toBe("M");
    expect(qr.version).toBe(3);
    expect(qr.mask).toBeGreaterThanOrEqual(0);
    expect(qr.mask).toBeLessThanOrEqual(7);
  });

  it("uses size = 21 + 4 * (version - 1) with a square matrix", () => {
    for (const text of ["a", URL, URL60, TEXT200, TEXT1000, MAX_L]) {
      const qr = encodeQr(text, text === MAX_L ? "L" : "M");
      expect(qr.size).toBe(21 + 4 * (qr.version - 1));
      expect(qr.modules).toHaveLength(qr.size);
      for (const row of qr.modules) expect(row).toHaveLength(qr.size);
    }
  });

  it("picks the smallest version that fits the byte capacity", () => {
    // Byte-mode capacities from ISO/IEC 18004 Table 7.
    expect(encodeQr("x".repeat(17), "L").version).toBe(1);
    expect(encodeQr("x".repeat(18), "L").version).toBe(2);
    expect(encodeQr("x".repeat(14), "M").version).toBe(1);
    expect(encodeQr("x".repeat(15), "M").version).toBe(2);
    expect(encodeQr("x".repeat(7), "H").version).toBe(1);
    expect(encodeQr("x".repeat(8), "H").version).toBe(2);
    expect(encodeQr("x".repeat(271), "L").version).toBe(10); // first 16-bit count
    expect(encodeQr("x".repeat(2331), "M").version).toBe(40);
    expect(encodeQr("x".repeat(1663), "Q").version).toBe(40);
    expect(encodeQr("x".repeat(1273), "H").version).toBe(40);
  });

  it("draws the three finder patterns with their separators", () => {
    for (const text of ["a", URL, TEXT200]) {
      const qr = encodeQr(text);
      const far = qr.size - 7;
      expectFinderAt(qr, 0, 0);
      expectFinderAt(qr, far, 0);
      expectFinderAt(qr, 0, far);
      expectSeparatorAround(qr, 0, 0);
      expectSeparatorAround(qr, far, 0);
      expectSeparatorAround(qr, 0, far);
    }
  });

  it("draws alternating timing patterns on row 6 and column 6", () => {
    for (const text of ["a", URL, TEXT200]) {
      const qr = encodeQr(text);
      for (let i = 8; i < qr.size - 8; i++) {
        expect(qr.modules[6][i], `row 6, x=${i}`).toBe(i % 2 === 0);
        expect(qr.modules[i][6], `col 6, y=${i}`).toBe(i % 2 === 0);
      }
    }
  });

  it("sets the dark module at (x=8, y=4v+9)", () => {
    for (const text of ["a", URL, URL60, TEXT200, TEXT1000]) {
      for (const ecc of ["L", "M", "Q", "H"] as const) {
        const qr = encodeQr(text, ecc);
        expect(qr.modules[4 * qr.version + 9][8]).toBe(true);
      }
    }
  });

  it("places an alignment pattern from version 2 on", () => {
    const qr = encodeQr(URL); // version 3
    const c = qr.size - 7;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        expect(qr.modules[c + dy][c + dx]).toBe(Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  });

  it("writes both copies of the format information", () => {
    // Known BCH(15,5) words after the 0x5412 mask (ISO/IEC 18004 Annex C), mask 0.
    const expected: Record<QrErrorCorrection, number> = { L: 0x77c4, M: 0x5412, Q: 0x355f, H: 0x1689 };
    for (const ecc of ["L", "M", "Q", "H"] as const) {
      const qr = encodeQr(URL, ecc, { mask: 0 });
      const m = qr.modules;
      const n = qr.size;
      const copy1 = [
        m[0][8], m[1][8], m[2][8], m[3][8], m[4][8], m[5][8], m[7][8], m[8][8],
        m[8][7], m[8][5], m[8][4], m[8][3], m[8][2], m[8][1], m[8][0],
      ];
      const copy2 = [
        ...Array.from({ length: 8 }, (_, i) => m[8][n - 1 - i]),
        ...Array.from({ length: 7 }, (_, i) => m[n - 7 + i][8]),
      ];
      const toInt = (bits: boolean[]) => bits.reduce((acc, b, i) => acc | ((b ? 1 : 0) << i), 0);
      expect(toInt(copy1)).toBe(expected[ecc]);
      expect(toInt(copy2)).toBe(expected[ecc]);
    }
  });

  it("writes the version information blocks from version 7 on", () => {
    // Version 7 → 0x07C94 (ISO/IEC 18004 Annex D).
    const qr = encodeQr("x".repeat(150), "L");
    expect(qr.version).toBe(7);
    const n = qr.size;
    let topRight = 0;
    let bottomLeft = 0;
    for (let i = 0; i < 18; i++) {
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      if (qr.modules[b][a]) topRight |= 1 << i;
      if (qr.modules[a][b]) bottomLeft |= 1 << i;
    }
    expect(topRight).toBe(0x07c94);
    expect(bottomLeft).toBe(0x07c94);
  });

  it("matches a frozen reference matrix for the pairing URL (version 3-M)", () => {
    // Generated with Project Nayuki's qrcodegen (Python) and decoded with zxing-cpp.
    const expected = [
      "#######..##...#....#..#######",
      "#.....#...###.####....#.....#",
      "#.###.#.###.#.......#.#.###.#",
      "#.###.#.###.##.####.#.#.###.#",
      "#.###.#.###...#..#.#..#.###.#",
      "#.....#.##..#.##..#...#.....#",
      "#######.#.#.#.#.#.#.#.#######",
      "........####..#...##.........",
      "#.#####..#...#.######.#####..",
      "..####.##..##.#....#..#.#...#",
      ".#.##.#..###.######..#.......",
      "#..#....#####..#..##...#.#.#.",
      "###...#.#####..####.##...##..",
      "#......###..##.....#..#.#...#",
      ".#...###.....####.#.#....##..",
      "######.##.####.##.#..##.#..#.",
      ".#..###...###.#.###.##.#.##..",
      "##.#.#.#.###.....###..#.#.#.#",
      "#.###.#.#..#...#.#...####.#..",
      "#...#..#..#...#....###.....#.",
      "#.#.###....##..##########.###",
      "........###.###.#.#.#...#####",
      "#######..############.#.###..",
      "#.....#.##...#.#....#...#...#",
      "#.###.#.#...#.#..#..#####.#..",
      "#.###.#.#..##...#....#.#.####",
      "#.###.#.###...###.#..##.####.",
      "#.....#...##.#.#..###.###..#.",
      "#######.#.###.##.#...##.###..",
    ];
    const qr = encodeQr(URL, "M");
    expect(qr.mask).toBe(2);
    expect(qr.modules.map((row) => row.map((d) => (d ? "#" : ".")).join(""))).toEqual(expected);
  });

  it("matches reference fingerprints (Nayuki qrcodegen) across sizes and levels", () => {
    expect(byteLength(URL60)).toBe(61);
    expect(byteLength(UTF8)).toBe(43); // accents and emoji are multi-byte in UTF-8
    // [text, level, version, mask, FNV-1a of the matrix]
    const cases: [string, QrErrorCorrection, number, number, number][] = [
      ["a", "L", 1, 0, 0xa2c36199],
      ["a", "M", 1, 5, 0x73643e4b],
      ["a", "Q", 1, 0, 0x4d326e33],
      ["a", "H", 1, 6, 0x1e436eb5],
      [URL, "L", 3, 7, 0x352ae1b9],
      [URL, "M", 3, 2, 0xed610d58],
      [URL, "Q", 4, 0, 0x5074a4a5],
      [URL, "H", 5, 6, 0xcb256b61],
      [URL60, "M", 4, 2, 0xb2914218],
      [UTF8, "M", 4, 2, 0xfd6fe056],
      [UTF8, "H", 5, 7, 0xe817fca7],
      [TEXT200, "L", 9, 2, 0x31ecb5ed],
      [TEXT200, "M", 10, 2, 0xa0c49d83],
      [TEXT200, "Q", 12, 2, 0x728ee5cf],
      [TEXT200, "H", 15, 4, 0x0a84333c],
      [TEXT1000, "Q", 31, 2, 0x0bf51f94],
      [MAX_L, "L", 40, 0, 0xad28ed47],
    ];
    for (const [text, ecc, version, mask, hash] of cases) {
      const qr = encodeQr(text, ecc);
      const label = `${text.slice(0, 12)}… ${ecc}`;
      expect(qr.version, label).toBe(version);
      expect(qr.mask, label).toBe(mask);
      expect(fingerprint(qr), label).toBe(hash);
    }
  });

  it("throws when the text does not fit in version 40", () => {
    expect(() => encodeQr("x".repeat(2954), "L")).toThrow(/too long/);
    expect(() => encodeQr("x".repeat(2332), "M")).toThrow(/too long/);
    expect(() => encodeQr("x".repeat(1274), "H")).toThrow(/too long/);
    // Capacity is in bytes: 1166 × "é" = 2332 bytes > 2331.
    expect(() => encodeQr("é".repeat(1166), "M")).toThrow(/2332 bytes/);
  });

  it("rejects invalid options", () => {
    expect(() => encodeQr("a", "X" as QrErrorCorrection)).toThrow();
    expect(() => encodeQr("a", "M", { mask: 8 })).toThrow();
  });
});

describe("qrToSvgPath", () => {
  /** Rebuild the module matrix from the path's "M x y h len v1 h-len z" runs. */
  function rasterize(d: string, side: number): boolean[][] {
    const grid = Array.from({ length: side }, () => new Array<boolean>(side).fill(false));
    const re = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;
    let consumed = 0;
    for (const match of d.matchAll(re)) {
      const [whole, x, y, len, back] = match;
      expect(back).toBe(len);
      for (let i = 0; i < Number(len); i++) {
        expect(grid[Number(y)][Number(x) + i]).toBe(false); // no overlapping runs
        grid[Number(y)][Number(x) + i] = true;
      }
      consumed += whole.length;
    }
    expect(consumed).toBe(d.length); // nothing but runs in the path
    return grid;
  }

  it("covers exactly the dark modules, offset by the margin", () => {
    const qr = encodeQr(URL);
    const { viewBox, d } = qrToSvgPath(qr);
    expect(viewBox).toBe(`0 0 ${qr.size + 8} ${qr.size + 8}`);
    const grid = rasterize(d, qr.size + 8);
    for (let y = 0; y < qr.size + 8; y++) {
      for (let x = 0; x < qr.size + 8; x++) {
        const inside = x >= 4 && y >= 4 && x < qr.size + 4 && y < qr.size + 4;
        expect(grid[y][x]).toBe(inside ? qr.modules[y - 4][x - 4] : false);
      }
    }
  });

  it("merges horizontal runs and honours a custom margin", () => {
    const qr = encodeQr("a");
    const { viewBox, d } = qrToSvgPath(qr, 0);
    expect(viewBox).toBe("0 0 21 21");
    // The top row starts with the 7-module finder edge as a single run.
    expect(d.startsWith("M0 0h7v1h-7z")).toBe(true);
    const grid = rasterize(d, 21);
    expect(grid).toEqual(qr.modules);
  });
});
