#!/usr/bin/env bash
# Harness E2E: dirige o binário debug via X11 (xdotool/import).
# Uso: e2e.sh start | shot <png> | type <texto> | key <tecla> | click <x> <y> | log [n] | stop
set -u
cd "$(dirname "$0")/.."
BIN="${E2E_BIN:-src-tauri/target/debug/head-terminal-dev}"
STATE="${TMPDIR:-/tmp}/head-terminal-e2e"

wid() { cat "$STATE.wid"; }

case "${1:-}" in
  start)
    "$BIN" >"$STATE.log" 2>&1 &
    echo $! >"$STATE.pid"
    for _ in $(seq 1 60); do
      WID=$(xdotool search --onlyvisible --pid "$(cat "$STATE.pid")" 2>/dev/null | head -1)
      if [ -n "$WID" ]; then echo "$WID" >"$STATE.wid"; echo "OK window=$WID"; exit 0; fi
      kill -0 "$(cat "$STATE.pid")" 2>/dev/null || { echo "CRASH ao iniciar:"; tail -20 "$STATE.log"; exit 1; }
      sleep 0.5
    done
    echo "TRAVOU: janela nao apareceu em 30s"; tail -20 "$STATE.log"; exit 1
    ;;
  shot)  sleep 0.3; import -window "$(wid)" "${2:?destino.png}" && echo "shot: $2" ;;
  # ponytail: XTEST na janela focada — WebKitGTK ignora eventos XSendEvent
  type)  xdotool windowactivate --sync "$(wid)"; xdotool type --delay 40 "${2:?texto}" ;;
  key)   xdotool windowactivate --sync "$(wid)"; xdotool key "${2:?tecla}" ;;
  click) xdotool windowactivate --sync "$(wid)"; xdotool mousemove --window "$(wid)" "${2:?x}" "${3:?y}" click 1 ;;
  log)   tail -n "${2:-30}" "$STATE.log" ;;
  stop)  kill "$(cat "$STATE.pid")" 2>/dev/null; sleep 1; kill -9 "$(cat "$STATE.pid")" 2>/dev/null; echo "stopped" ;;
  *) echo "uso: $0 start|shot|type|key|click|log|stop"; exit 2 ;;
esac
