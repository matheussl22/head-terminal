import { describe, expect, it } from "vitest";

import { isBareMouseHoverReport } from "./pty-text";

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
