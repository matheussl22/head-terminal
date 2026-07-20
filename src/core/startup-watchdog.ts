import { captureStartupSnapshot } from "./startup-snapshot";
import {
  checkpoint,
  isUiReady,
  logEvent,
  markUiReady,
} from "./logger";

const SLOW_BOOT_MS = 8_000;
const BLACK_SCREEN_MS = 15_000;
const UI_READY_FALLBACK_MS = 30_000;

let started = false;
let slowLogged = false;
let blackScreenLogged = false;
const timerIds: ReturnType<typeof setTimeout>[] = [];

function clearWatchdogTimers(): void {
  for (const id of timerIds) {
    clearTimeout(id);
  }
  timerIds.length = 0;
}

export function stopStartupWatchdog(): void {
  clearWatchdogTimers();
  started = false;
}

export function startStartupWatchdog(): void {
  if (started) {
    return;
  }
  started = true;

  timerIds.push(
    setTimeout(() => {
      checkpoint("watchdog.3s", captureStartupSnapshot());
    }, 3_000),
  );

  timerIds.push(
    setTimeout(() => {
      if (isUiReady()) {
        return;
      }
      if (!slowLogged) {
        slowLogged = true;
        logEvent("warn", "bootstrap.slow", captureStartupSnapshot());
      }
    }, SLOW_BOOT_MS),
  );

  timerIds.push(
    setTimeout(() => {
      if (isUiReady()) {
        return;
      }
      if (!blackScreenLogged) {
        blackScreenLogged = true;
        logEvent("error", "black_screen.suspected", captureStartupSnapshot());
      }
    }, BLACK_SCREEN_MS),
  );

  timerIds.push(
    setTimeout(() => {
      if (isUiReady()) {
        return;
      }
      logEvent("warn", "ui.ready.timeout", captureStartupSnapshot());
      markUiReady({ reason: "timeout_fallback" });
      stopStartupWatchdog();
    }, UI_READY_FALLBACK_MS),
  );
}

export function notifyUiReady(): void {
  if (isUiReady()) {
    return;
  }
  markUiReady(captureStartupSnapshot());
  stopStartupWatchdog();
}
