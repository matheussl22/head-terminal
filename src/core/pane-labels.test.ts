import { describe, expect, it } from "vitest";

import { paneShortLabel } from "./pane-labels";

describe("paneShortLabel", () => {
  it("names a terminal by its agent and its place in the layout", () => {
    expect(paneShortLabel("claude", 2)).toBe("cc3");
    expect(paneShortLabel("shell", 0)).toBe("sh1");
    expect(paneShortLabel("codex", 9)).toBe("cdx10");
  });

  it("falls back to the first letters of an agent it does not know", () => {
    expect(paneShortLabel("gemini", 0)).toBe("gem1");
  });
});
