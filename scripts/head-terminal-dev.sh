#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/runtime-env.sh"

notify_error() {
  local message="$1"
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --title="Head Terminal (Dev)" --text="$message" 2>/dev/null || true
  elif command -v kdialog >/dev/null 2>&1; then
    kdialog --error "$message" 2>/dev/null || true
  else
    echo "$message" >&2
  fi
}

DEV_BIN="$ROOT/src-tauri/target/debug/head-terminal-dev"
LOG_DIR="$(ensure_log_dir)"
LOG_FILE="$LOG_DIR/dev.log"

if [[ ! -x "$DEV_BIN" ]]; then
  if command -v npm >/dev/null 2>&1; then
    (
      cd "$ROOT"
      npm run build:dev
    ) >>"$LOG_FILE" 2>&1 || {
      notify_error "Falha ao compilar o modo dev. Veja o log:\n$LOG_FILE"
      exit 1
    }
  else
    notify_error "Binário dev não encontrado. Rode no projeto:\n\nnpm run build:dev"
    exit 1
  fi
fi

ensure_display

if [[ -z "${DISPLAY:-}" ]]; then
  notify_error "DISPLAY não encontrado. Abra pelo terminal gráfico ou exporte DISPLAY=:0"
  exit 1
fi

{
  echo "----- $(date -Is) start:dev bin=$DEV_BIN DISPLAY=$DISPLAY -----"
} >>"$LOG_FILE"

exec zsh -ic 'exec "$1"' zsh "$DEV_BIN" >>"$LOG_FILE" 2>&1
