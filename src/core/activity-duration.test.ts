import { describe, expect, it } from "vitest";

import {
  formatActivityDuration,
  formatSessionStatusLine,
} from "./activity-duration";

describe("formatActivityDuration", () => {
  it("formats seconds and minutes", () => {
    const now = 1_000_000;
    expect(formatActivityDuration(now - 15_000, now)).toBe("15s");
    expect(formatActivityDuration(now - 120_000, now)).toBe("2m");
  });
});

describe("formatSessionStatusLine", () => {
  it("adds duration for working state", () => {
    const now = 1_000_000;
    expect(
      formatSessionStatusLine("working", now - 90_000, now),
    ).toBe("Executando há 1m");
  });

  it("omits duration for idle", () => {
    expect(formatSessionStatusLine("idle", Date.now(), Date.now())).toBe(
      "Ativo",
    );
  });
});
