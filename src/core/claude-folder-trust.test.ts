import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ClaudeFolderTrustAutoAccept,
  CLAUDE_FOLDER_TRUST_CONFIRM_KEY,
  isClaudeFolderTrustPrompt,
} from "./claude-folder-trust";

const CURRENT_PROMPT = [
  "Quick safety check",
  "Is this a project you created or one you trust?",
  "> 1. Yes, I trust this folder",
  "  2. No, exit",
  "Enter to confirm · Esc to cancel",
].join("\n");

const LEGACY_PROMPT = [
  "Do you trust the files in this folder?",
  "/Users/mathe",
  "❯ 1. Yes, proceed",
  "  2. No, exit",
].join("\n");

describe("isClaudeFolderTrustPrompt", () => {
  it("matches the current Quick safety check dialog", () => {
    expect(isClaudeFolderTrustPrompt(CURRENT_PROMPT)).toBe(true);
  });

  it("matches the older Do you trust the files dialog", () => {
    expect(isClaudeFolderTrustPrompt(LEGACY_PROMPT)).toBe(true);
  });

  it("matches when Ink wraps the copy in SGR and cursor moves", () => {
    const painted =
      "\x1b[1mYes, I trust this folder\x1b[0m\n  2. \x1b[2mNo, exit\x1b[0m";
    expect(isClaudeFolderTrustPrompt(painted)).toBe(true);
  });

  it("does not treat a later tool-approval prompt as folder trust", () => {
    expect(
      isClaudeFolderTrustPrompt(
        "Do you want to make this edit?\n❯ 1. Yes\n  2. No\n",
      ),
    ).toBe(false);
  });

  it("does not match the phrase without the exit option", () => {
    expect(isClaudeFolderTrustPrompt("Yes, I trust this folder")).toBe(false);
  });
});

describe("ClaudeFolderTrustAutoAccept", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("confirms once after the prompt has been painted", () => {
    const confirm = vi.fn();
    const watcher = new ClaudeFolderTrustAutoAccept();

    watcher.onData("Quick safety check\n", confirm);
    expect(confirm).not.toHaveBeenCalled();

    watcher.onData(CURRENT_PROMPT, confirm);
    expect(confirm).not.toHaveBeenCalled();

    vi.advanceTimersByTime(80);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith();

    watcher.onData(CURRENT_PROMPT, confirm);
    vi.advanceTimersByTime(200);
    expect(confirm).toHaveBeenCalledTimes(1);

    watcher.dispose();
  });

  it("assembles a prompt that arrives split across chunks", () => {
    const confirm = vi.fn();
    const watcher = new ClaudeFolderTrustAutoAccept();

    watcher.onData("Yes, I trust this folder\n", confirm);
    watcher.onData("  2. No, exit\n", confirm);
    vi.advanceTimersByTime(80);

    expect(confirm).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it("does not confirm a generic numbered approval", () => {
    const confirm = vi.fn();
    const watcher = new ClaudeFolderTrustAutoAccept();

    watcher.onData("Do you want to run this command?\n❯ 1. Yes\n  2. No\n", confirm);
    vi.advanceTimersByTime(200);

    expect(confirm).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("cancels a pending confirm on dispose", () => {
    const confirm = vi.fn();
    const watcher = new ClaudeFolderTrustAutoAccept();

    watcher.onData(CURRENT_PROMPT, confirm);
    watcher.dispose();
    vi.advanceTimersByTime(200);

    expect(confirm).not.toHaveBeenCalled();
  });

  it("sends carriage return, the same key Head Terminal uses for Enter", () => {
    expect(CLAUDE_FOLDER_TRUST_CONFIRM_KEY).toBe("\r");
  });
});
