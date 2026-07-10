#!/usr/bin/env bash
# Harness E2E: dirige o binário debug via X11 (xdotool/import) num display
# virtual próprio (Xvfb se instalado, senão Xephyr) — não toca no mouse,
# teclado ou foco do usuário.
# Uso: e2e.sh start | shot <png> | type <texto> | key <tecla> | click <x> <y> | log [n] | stop
set -u
cd "$(dirname "$0")/.."
BIN="${E2E_BIN:-src-tauri/target/debug/head-terminal-dev}"
STATE="${TMPDIR:-/tmp}/head-terminal-e2e"
XDISP="${E2E_DISPLAY:-:9}"
GEOM="${E2E_GEOM:-1280x800}"

wid() { cat "$STATE.wid"; }
# Todos os comandos de input/screenshot falam com o display virtual.
xd() { DISPLAY="$XDISP" xdotool "$@"; }

case "${1:-}" in
  start)
    if ! DISPLAY="$XDISP" xdpyinfo >/dev/null 2>&1; then
      if command -v Xvfb >/dev/null; then
        Xvfb "$XDISP" -screen 0 "${GEOM}x24" >/dev/null 2>&1 &
      else
        # ponytail: Xephyr abre uma janela na tela real (dá pra minimizar);
        # instalar xvfb torna o harness 100% invisível.
        Xephyr "$XDISP" -screen "$GEOM" -title "head-terminal E2E" >/dev/null 2>&1 &
      fi
      echo $! >"$STATE.xpid"
      for _ in $(seq 1 20); do
        DISPLAY="$XDISP" xdpyinfo >/dev/null 2>&1 && break
        sleep 0.25
      done
    fi
    DISPLAY="$XDISP" WEBKIT_DISABLE_COMPOSITING_MODE=1 "$BIN" >"$STATE.log" 2>&1 &
    echo $! >"$STATE.pid"
    for _ in $(seq 1 60); do
      WID=$(xd search --onlyvisible --pid "$(cat "$STATE.pid")" 2>/dev/null | head -1)
      if [ -n "$WID" ]; then echo "$WID" >"$STATE.wid"; echo "OK window=$WID display=$XDISP"; exit 0; fi
      kill -0 "$(cat "$STATE.pid")" 2>/dev/null || { echo "CRASH ao iniciar:"; tail -20 "$STATE.log"; exit 1; }
      sleep 0.5
    done
    echo "TRAVOU: janela nao apareceu em 30s"; tail -20 "$STATE.log"; exit 1
    ;;
  shot)  sleep 0.3; DISPLAY="$XDISP" import -window "$(wid)" "${2:?destino.png}" && echo "shot: $2" ;;
  # ponytail: XTEST na janela focada — WebKitGTK ignora eventos XSendEvent.
  # windowfocus (não windowactivate): o display virtual não tem WM/EWMH.
  type)  xd windowfocus --sync "$(wid)"; xd type --delay 40 "${2:?texto}" ;;
  key)   xd windowfocus --sync "$(wid)"; xd key "${2:?tecla}" ;;
  click) xd windowfocus --sync "$(wid)"; xd mousemove --window "$(wid)" "${2:?x}" "${3:?y}" click 1 ;;
  log)   tail -n "${2:-30}" "$STATE.log" ;;
  stop)
    kill "$(cat "$STATE.pid")" 2>/dev/null; sleep 1; kill -9 "$(cat "$STATE.pid")" 2>/dev/null
    [ -f "$STATE.xpid" ] && kill "$(cat "$STATE.xpid")" 2>/dev/null && rm -f "$STATE.xpid"
    echo "stopped"
    ;;
  *) echo "uso: $0 start|shot|type|key|click|log|stop"; exit 2 ;;
esac
