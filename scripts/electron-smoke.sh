#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BINARY="${HEAD_TERMINAL_SMOKE_BINARY:-$PROJECT_DIR/out/Head Terminal-linux-x64/head-terminal}"
SMOKE_TIMEOUT_SECONDS="${HEAD_TERMINAL_SMOKE_TIMEOUT_SECONDS:-30}"
SMOKE_TMP_DIR="$(mktemp -d -t head-terminal-electron-smoke.XXXXXX)"
XVFB_PID=""
APP_PID=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    if [[ -n "${window_id:-}" && -n "${DISPLAY:-}" ]]; then
      DISPLAY="$DISPLAY" xdotool windowclose "$window_id" 2>/dev/null || true
      for _ in {1..30}; do
        kill -0 "$APP_PID" 2>/dev/null || break
        sleep 0.1
      done
    fi
  fi

  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    # Let Electron run its before-quit drains before touching child processes.
    kill -TERM "$APP_PID" 2>/dev/null || true
    for _ in {1..50}; do
      kill -0 "$APP_PID" 2>/dev/null || break
      sleep 0.1
    done
  fi

  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM -- "-$APP_PID" 2>/dev/null || true
    kill -KILL -- "-$APP_PID" 2>/dev/null || kill -KILL "$APP_PID" 2>/dev/null || true
  fi
  [[ -n "$APP_PID" ]] && wait "$APP_PID" 2>/dev/null || true

  if [[ -n "$XVFB_PID" ]] && kill -0 "$XVFB_PID" 2>/dev/null; then
    kill -TERM "$XVFB_PID" 2>/dev/null || true
    wait "$XVFB_PID" 2>/dev/null || true
  fi

  if [[ $status -ne 0 ]]; then
    echo "Electron smoke logs: $SMOKE_TMP_DIR/app.log" >&2
    sed -n '1,240p' "$SMOKE_TMP_DIR/app.log" >&2 2>/dev/null || true
  else
    rm -r "$SMOKE_TMP_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

if [[ ! -x "$APP_BINARY" ]]; then
  echo "Electron package not found at $APP_BINARY; run 'npm run package' first." >&2
  exit 1
fi

if ! command -v xdotool >/dev/null 2>&1; then
  if [[ "${HEAD_TERMINAL_SMOKE_REQUIRE_DISPLAY:-0}" == "1" ]]; then
    echo "xdotool is required for the Electron window smoke test." >&2
    exit 1
  fi
  echo "SKIP electron smoke: xdotool is unavailable"
  exit 0
fi

if [[ -z "${DISPLAY:-}" ]] || ! DISPLAY="$DISPLAY" xdotool getmouselocation >/dev/null 2>&1; then
  if ! command -v Xvfb >/dev/null 2>&1; then
    if [[ "${HEAD_TERMINAL_SMOKE_REQUIRE_DISPLAY:-0}" == "1" ]]; then
      echo "No usable DISPLAY and Xvfb is unavailable." >&2
      exit 1
    fi
    echo "SKIP electron smoke: no usable DISPLAY or Xvfb"
    exit 0
  fi

  for display_number in {90..119}; do
    if [[ ! -e "/tmp/.X11-unix/X$display_number" ]]; then
      export DISPLAY=":$display_number"
      break
    fi
  done
  if [[ -z "${DISPLAY:-}" ]]; then
    echo "No free Xvfb display in the reserved smoke range." >&2
    exit 1
  fi

  Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp >"$SMOKE_TMP_DIR/xvfb.log" 2>&1 &
  XVFB_PID=$!
  for _ in {1..50}; do
    DISPLAY="$DISPLAY" xdotool getmouselocation >/dev/null 2>&1 && break
    kill -0 "$XVFB_PID" 2>/dev/null || {
      echo "Xvfb exited before becoming ready." >&2
      exit 1
    }
    sleep 0.1
  done
fi

export HEAD_TERMINAL_CHANNEL="smoke"
export HEAD_TERMINAL_SMOKE="1"
setsid "$APP_BINARY" \
  --disable-gpu \
  --enable-logging=stderr \
  --ozone-platform=x11 \
  --user-data-dir="$SMOKE_TMP_DIR/user-data" \
  >"$SMOKE_TMP_DIR/app.log" 2>&1 &
APP_PID=$!

deadline=$((SECONDS + SMOKE_TIMEOUT_SECONDS))
window_id=""
while (( SECONDS < deadline )); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "Electron exited before presenting its main window." >&2
    exit 1
  fi
  # The renderer intentionally updates the title with active-session context,
  # so identify the BrowserWindow by its owning Electron process first.
  window_id="$(DISPLAY="$DISPLAY" xdotool search --onlyvisible --pid "$APP_PID" 2>/dev/null | head -n 1 || true)"
  if [[ -z "$window_id" ]]; then
    window_id="$(DISPLAY="$DISPLAY" xdotool search --onlyvisible --name 'Head Terminal' 2>/dev/null | head -n 1 || true)"
  fi
  [[ -n "$window_id" ]] && break
  sleep 0.25
done

if [[ -z "$window_id" ]]; then
  echo "Timed out waiting for the Electron main window." >&2
  exit 1
fi

window_title="$(DISPLAY="$DISPLAY" xdotool getwindowname "$window_id")"
if [[ -z "$window_title" ]]; then
  echo "Electron window has an empty title after renderer boot." >&2
  exit 1
fi

# A visible window alone is insufficient: the packaged native module must
# create a real PTY. The smoke profile starts a plain shell and emits this
# renderer checkpoint only after terminal:spawn succeeds.
while (( SECONDS < deadline )); do
  if grep -q 'js\.pty\.spawn_failed\|node-pty is unavailable' "$SMOKE_TMP_DIR/app.log"; then
    echo "Packaged renderer failed to create its PTY." >&2
    exit 1
  fi
  grep -q 'js\.pty\.spawn_ok' "$SMOKE_TMP_DIR/app.log" && break
  kill -0 "$APP_PID" 2>/dev/null || {
    echo "Electron crashed before packaged PTY startup." >&2
    exit 1
  }
  sleep 0.1
done

if ! grep -q 'js\.pty\.spawn_ok' "$SMOKE_TMP_DIR/app.log"; then
  echo "Timed out waiting for packaged PTY startup." >&2
  exit 1
fi

echo "SMOKE_OK pid=$APP_PID window=$window_id title=$window_title display=$DISPLAY pty=ready"
