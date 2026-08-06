import { describe, expect, it } from "vitest";

import { isBareMouseHoverReport, isFocusReport } from "./pty-text";

describe("isBareMouseHoverReport", () => {
  it("detecta hover puro (motion bit + sem botão)", () => {
    // Cb=35 = 32 (motion) | 3 (nenhum botão)
    expect(isBareMouseHoverReport("\x1b[<35;10;20M")).toBe(true);
  });

  it("ignora clique (sem motion bit)", () => {
    // Cb=0 = botão esquerdo pressionado, sem motion
    expect(isBareMouseHoverReport("\x1b[<0;10;20M")).toBe(false);
  });

  it("ignora drag (motion bit + botão pressionado)", () => {
    // Cb=32 = motion | botão esquerdo (0) mantido
    expect(isBareMouseHoverReport("\x1b[<32;10;20M")).toBe(false);
  });

  it("ignora texto comum digitado", () => {
    expect(isBareMouseHoverReport("npm test\n")).toBe(false);
  });
});

describe("isFocusReport", () => {
  it("detecta focus-in (ESC[I)", () => {
    expect(isFocusReport("\x1b[I")).toBe(true);
  });

  it("detecta focus-out (ESC[O)", () => {
    expect(isFocusReport("\x1b[O")).toBe(true);
  });

  it("ignora texto comum digitado", () => {
    expect(isFocusReport("npm test\n")).toBe(false);
  });

  it("ignora sequências parecidas mas diferentes", () => {
    expect(isFocusReport("\x1b[1I")).toBe(false);
    expect(isFocusReport("\x1b[I extra")).toBe(false);
  });
});
