import { describe, expect, it } from "vitest";

import { WorkspaceDetector } from "./workspace-detector";

describe("WorkspaceDetector", () => {
  it("detects switched branch messages", () => {
    const paths: string[] = [];
    const detector = new WorkspaceDetector((path) => paths.push(path));

    detector.onData("Switched to branch 'feature/git-branch-tracker'\n");

    expect(paths).toEqual(["feature/git-branch-tracker"]);
  });

  it("detects file paths from edit messages", () => {
    const paths: string[] = [];
    const detector = new WorkspaceDetector((path) => paths.push(path));

    detector.onData("Editing src/core/session-manager.ts\n");

    expect(paths).toEqual(["src/core/session-manager.ts"]);
  });

  it("strips ansi sequences before matching", () => {
    const paths: string[] = [];
    const detector = new WorkspaceDetector((path) => paths.push(path));

    detector.onData("\x1b[32mOn branch main\x1b[0m\n");

    expect(paths).toEqual(["main"]);
  });
});
