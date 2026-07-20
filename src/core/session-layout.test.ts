import { describe, expect, it } from "vitest";

import {
  collectPaneIds,
  splitPaneInLayout,
  createInitialLayout,
  createPaneId,
} from "./session-layout";

describe("session-layout", () => {
  it("collects pane ids from nested splits", () => {
    const left = createPaneId();
    const right = createPaneId();
    const layout = splitPaneInLayout(
      createInitialLayout(left),
      left,
      "vertical",
      right,
    );

    expect(collectPaneIds(layout)).toEqual([left, right]);
  });
});
