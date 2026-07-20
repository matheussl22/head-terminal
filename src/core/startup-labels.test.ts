import { describe, expect, it } from "vitest";

import { humanizeCheckpoint } from "./startup-labels";

describe("humanizeCheckpoint", () => {
  it("humanizes known stages", () => {
    expect(humanizeCheckpoint("js.bootstrap.cwd_ok")).toBe(
      "Diretório padrão carregado",
    );
  });

  it("falls back to stage id", () => {
    expect(humanizeCheckpoint("custom.stage")).toBe("custom.stage");
  });

  it("handles null", () => {
    expect(humanizeCheckpoint(null)).toBe("Iniciando…");
  });
});
