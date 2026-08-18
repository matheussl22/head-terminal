import { afterEach, describe, expect, it, vi } from "vitest";

import { isCaptureSupported } from "./voice-capture";
import { isVoiceInputSupported } from "./voice-input";

const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HeadTerminal/0.1.0 Electron/41.6.0";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) HeadTerminal/0.1.0 Electron/41.6.0";

function withPlatform(userAgent: string, capture: boolean): void {
  vi.stubGlobal("navigator", {
    userAgent,
    language: "pt-BR",
    mediaDevices: capture ? { getUserMedia: () => Promise.resolve({}) } : undefined,
  });
  if (capture) {
    vi.stubGlobal("MediaRecorder", class {});
  } else {
    vi.stubGlobal("MediaRecorder", undefined);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("voice capture availability", () => {
  it("sees Chromium's microphone when the renderer can record", () => {
    withPlatform(WINDOWS_UA, true);
    expect(isCaptureSupported()).toBe(true);
  });

  it("reports nothing when the media stack is missing", () => {
    withPlatform(WINDOWS_UA, false);
    expect(isCaptureSupported()).toBe(false);
  });
});

describe("voice button visibility", () => {
  it("shows on Windows once the renderer can capture", () => {
    // The button used to be hidden there: recording went through `parecord`,
    // which is PulseAudio and never existed on Windows.
    withPlatform(WINDOWS_UA, true);
    expect(isVoiceInputSupported()).toBe(true);
  });

  it("stays hidden on Windows without a media stack", () => {
    withPlatform(WINDOWS_UA, false);
    expect(isVoiceInputSupported()).toBe(false);
  });

  it("keeps Linux on the main-process recorder either way", () => {
    withPlatform(LINUX_UA, false);
    expect(isVoiceInputSupported()).toBe(true);
  });
});
