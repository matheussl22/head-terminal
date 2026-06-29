import type { PaneActivity } from "../types/activity";
import { decodePtyData } from "./pty-text";

const WORKING_PATTERNS = [
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
  /\bRunning\b/i,
  /\bExecuting\b/i,
  /\bBuilding\b/i,
  /\bCompiling\b/i,
  /\bInstalling\b/i,
  /\bWaiting for approval\b/i,
];

const ERROR_PATTERNS = [
  /\[Erro\]/i,
  /\berror:\s/i,
  /\bENOENT\b/,
  /\bEPERM\b/,
  /Processo encerrado com código [1-9]/,
  /\bThinking\b/i,
  /\bPlanning\b/i,
  /\bSearching\b/i,
];

const WAITING_PATTERNS = [
  /[❯›]\s*$/,
  /\?\s*$/,
  />\s*$/,
  /\$\s*$/,
  /\(y\/n\)/i,
];

const IDLE_AFTER_MS = 1500;
const WAITING_AFTER_MS = 3000;
const RECENT_TEXT_LIMIT = 2000;

export class ActivityDetector {
  private lastOutputAt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private currentActivity: PaneActivity = "starting";
  private recentText = "";

  constructor(private readonly onActivityChange: (activity: PaneActivity) => void) {}

  onData(data: string | Uint8Array): void {
    const text = decodePtyData(data);

    this.lastOutputAt = Date.now();
    this.recentText = (this.recentText + text).slice(-RECENT_TEXT_LIMIT);

    const detected = this.detectFromRecentText();
    this.setActivity(detected ?? "working");
    this.scheduleIdleCheck();
  }

  onStarting(): void {
    this.setActivity("starting");
  }

  onRunning(): void {
    this.lastOutputAt = Date.now();
    this.setActivity("idle");
    this.scheduleIdleCheck();
  }

  onExit(exitCode: number): void {
    this.clearIdleTimer();
    this.setActivity(exitCode === 0 ? "exited" : "error");
  }

  onError(): void {
    this.clearIdleTimer();
    this.setActivity("error");
  }

  dispose(): void {
    this.clearIdleTimer();
  }

  private detectFromRecentText(): PaneActivity | null {
    // this.recentText already ends with the latest chunk (see onData), so
    // testing it alone covers matches that would otherwise require testing
    // the chunk separately.
    if (ERROR_PATTERNS.some((pattern) => pattern.test(this.recentText))) {
      return "error";
    }

    if (WORKING_PATTERNS.some((pattern) => pattern.test(this.recentText))) {
      return "working";
    }

    if (WAITING_PATTERNS.some((pattern) => pattern.test(this.recentText))) {
      return "waiting_input";
    }

    return null;
  }

  private scheduleIdleCheck(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      const elapsed = Date.now() - this.lastOutputAt;

      if (this.currentActivity === "exited" || this.currentActivity === "error") {
        return;
      }

      if (this.currentActivity === "working") {
        const remaining = WAITING_AFTER_MS - elapsed;
        if (remaining > 0) {
          this.idleTimer = setTimeout(() => {
            const laterElapsed = Date.now() - this.lastOutputAt;
            if (
              laterElapsed >= WAITING_AFTER_MS &&
              this.currentActivity !== "exited" &&
              this.currentActivity !== "error"
            ) {
              this.setActivity("waiting_input");
            }
          }, remaining);
          return;
        }

        this.setActivity("waiting_input");
        return;
      }

      if (elapsed >= IDLE_AFTER_MS) {
        this.setActivity("idle");
      }
    }, IDLE_AFTER_MS);
  }

  private setActivity(activity: PaneActivity): void {
    if (this.currentActivity === activity) {
      return;
    }

    this.currentActivity = activity;
    this.onActivityChange(activity);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
