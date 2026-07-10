#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/runtime-env.sh"

notify_error() {
  local message="$1"
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --title="Head Terminal" --text="$message" 2>/dev/null || true
  elif command -v kdialog >/dev/null 2>&1; then
    kdialog --error "$message" 2>/dev/null || true
  else
    echo "$message" >&2
  fi
}

RELEASE_BIN="$ROOT/src-tauri/target/release/head-terminal"
LOG_DIR="$(ensure_log_dir)"
LOG_FILE="$LOG_DIR/prod.log"

if [[ ! -x "$RELEASE_BIN" ]]; then
  notify_error "Binário de release não encontrado. Rode no projeto:\n\nnpm run build:release"
  exit 1
fi

ensure_display

if [[ -z "${DISPLAY:-}" ]]; then
  notify_error "DISPLAY não encontrado. Abra pelo terminal gráfico ou exporte DISPLAY=:0"
  exit 1
fi

{
  echo "----- $(date -Is) start:prod bin=$RELEASE_BIN DISPLAY=$DISPLAY -----"
} >>"$LOG_FILE"

exec zsh -ic 'exec "$1"' zsh "$RELEASE_BIN" >>"$LOG_FILE" 2>&1
