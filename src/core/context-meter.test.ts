import { describe, expect, it } from "vitest";

import { ContextMeter, extractContextPercent } from "./context-meter";

describe("extractContextPercent", () => {
  it("casa o aviso de auto-compact do Claude Code", () => {
    expect(
      extractContextPercent("Context left until auto-compact: 34%"),
    ).toBe(34);
  });

  it("casa aviso de contexto baixo", () => {
    expect(
      extractContextPercent("Context low (12% remaining) · Run /compact"),
    ).toBe(12);
  });

  it("usa a menção mais recente", () => {
    expect(
      extractContextPercent("62% context left ... depois 41% context left"),
    ).toBe(41);
  });

  it("ignora texto sem menção de contexto", () => {
    expect(extractContextPercent("npm install 100% concluído")).toBeNull();
  });
});

describe("ContextMeter", () => {
  it("emite só em mudança de percentual", () => {
    const values: number[] = [];
    const meter = new ContextMeter((percent) => values.push(percent));

    meter.onData("Context left until auto-compact: 40%\n");
    meter.onData("mais output qualquer\n");
    meter.onData("Context left until auto-compact: 38%\n");

    expect(values).toEqual([40, 38]);
  });
});
