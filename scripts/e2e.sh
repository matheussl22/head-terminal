#!/usr/bin/env bash
# Interactive Electron/X11 harness.
# Usage: e2e.sh start|shot <png>|type <text>|key <key>|click <x> <y>|log [n]|stop
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E_BINARY="${E2E_BIN:-$PROJECT_DIR/out/Head Terminal-linux-x64/head-terminal}"
E2E_STATE="${TMPDIR:-/tmp}/head-terminal-electron-e2e"
E2E_USER_DATA="${E2E_STATE}.user-data"
E2E_DISPLAY="${E2E_DISPLAY:-:89}"
E2E_GEOMETRY="${E2E_GEOM:-1280x800}"

window_id() { cat "$E2E_STATE.wid"; }
xd() { DISPLAY="$E2E_DISPLAY" xdotool "$@"; }

start_display() {
  if DISPLAY="$E2E_DISPLAY" xdpyinfo >/dev/null 2>&1; then
    return
  fi
  if command -v Xvfb >/dev/null 2>&1; then
    Xvfb "$E2E_DISPLAY" -screen 0 "${E2E_GEOMETRY}x24" -nolisten tcp >"$E2E_STATE.x.log" 2>&1 &
  elif command -v Xephyr >/dev/null 2>&1; then
    Xephyr "$E2E_DISPLAY" -screen "$E2E_GEOMETRY" -title "Head Terminal E2E" >"$E2E_STATE.x.log" 2>&1 &
  else
    echo "Instale Xvfb (recomendado) ou Xephyr para executar o E2E isolado." >&2
    exit 1
  fi
  echo $! >"$E2E_STATE.xpid"
  for _ in {1..40}; do
    DISPLAY="$E2E_DISPLAY" xdpyinfo >/dev/null 2>&1 && return
    sleep 0.25
  done
  echo "Display $E2E_DISPLAY não ficou pronto." >&2
  exit 1
}

case "${1:-}" in
  start)
    command -v xdotool >/dev/null 2>&1 || {
      echo "xdotool é necessário para o E2E." >&2
      exit 1
    }
    if [[ ! -x "$E2E_BINARY" ]]; then
      echo "Pacote ausente; criando com npm run package..."
      (cd "$PROJECT_DIR" && npm run package)
    fi
    start_display
    mkdir -p "$E2E_USER_DATA"
    setsid env \
      DISPLAY="$E2E_DISPLAY" \
      "$E2E_BINARY" \
      --disable-gpu \
      --ozone-platform=x11 \
      --user-data-dir="$E2E_USER_DATA" \
      >"$E2E_STATE.log" 2>&1 &
    echo $! >"$E2E_STATE.pid"
    for _ in {1..120}; do
      pid="$(cat "$E2E_STATE.pid")"
      wid="$(xd search --onlyvisible --pid "$pid" 2>/dev/null | head -n 1 || true)"
      if [[ -n "$wid" ]]; then
        echo "$wid" >"$E2E_STATE.wid"
        echo "OK window=$wid display=$E2E_DISPLAY"
        exit 0
      fi
      kill -0 "$pid" 2>/dev/null || {
        echo "Electron encerrou durante o boot:" >&2
        tail -n 80 "$E2E_STATE.log" >&2
        exit 1
      }
      sleep 0.25
    done
    echo "Janela Electron não apareceu em 30 segundos." >&2
    tail -n 80 "$E2E_STATE.log" >&2
    exit 1
    ;;
  shot)
    sleep 0.3
    DISPLAY="$E2E_DISPLAY" import -window "$(window_id)" "${2:?destino.png}"
    echo "shot: $2"
    ;;
  type)
    xd windowfocus --sync "$(window_id)"
    xd type --delay 40 "${2:?texto}"
    ;;
  key)
    xd windowfocus --sync "$(window_id)"
    xd key "${2:?tecla}"
    ;;
  click)
    xd windowfocus --sync "$(window_id)"
    xd mousemove --window "$(window_id)" "${2:?x}" "${3:?y}" click 1
    ;;
  log)
    tail -n "${2:-80}" "$E2E_STATE.log"
    ;;
  stop)
    if [[ -f "$E2E_STATE.pid" ]]; then
      pid="$(cat "$E2E_STATE.pid")"
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      sleep 1
      kill -KILL -- "-$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
    if [[ -f "$E2E_STATE.xpid" ]]; then
      xpid="$(cat "$E2E_STATE.xpid")"
      kill -TERM "$xpid" 2>/dev/null || true
    fi
    rm -f "$E2E_STATE.pid" "$E2E_STATE.wid" "$E2E_STATE.xpid"
    rm -r "$E2E_USER_DATA" 2>/dev/null || true
    echo "stopped"
    ;;
  *)
    echo "uso: $0 start|shot|type|key|click|log|stop" >&2
    exit 2
    ;;
esac
