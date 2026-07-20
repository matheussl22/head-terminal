import { describe, expect, it } from "vitest";

import { diffLineClass } from "./SessionDiffPanel";

describe("diffLineClass", () => {
  it("classifica linhas de diff", () => {
    expect(diffLineClass("+novo")).toContain("--add");
    expect(diffLineClass("-velho")).toContain("--del");
    expect(diffLineClass("+++ b/arquivo")).toContain("--file");
    expect(diffLineClass("--- a/arquivo")).toContain("--file");
    expect(diffLineClass("@@ -1,3 +1,4 @@")).toContain("--meta");
    expect(diffLineClass("?? novo arquivo (untracked): x")).toContain("--meta");
    expect(diffLineClass(" contexto")).toBe("session-diff__line");
  });
});
