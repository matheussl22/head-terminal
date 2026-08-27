#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$PROJECT_DIR/scripts/head-terminal-env.sh"
# shellcheck disable=SC1091
source "$PROJECT_DIR/scripts/lib/runtime-env.sh"

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

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  notify_error "Node.js 20+ e npm são necessários para iniciar o modo dev."
  exit 1
fi

if [[ ! -d "$PROJECT_DIR/node_modules" ]]; then
  notify_error "Dependências ausentes. Rode no projeto: npm install"
  exit 1
fi

ensure_display
LOG_DIR="$(ensure_log_dir)"
LOG_FILE="$LOG_DIR/dev.log"
export HEAD_TERMINAL_CHANNEL="dev"

mapfile -t KEYRING_ARGS < <(keyring_fallback_args)

echo "----- $(date -Is) electron:dev DISPLAY=${DISPLAY:-wayland} keyring=${KEYRING_ARGS[*]:-ok} -----" >>"$LOG_FILE"
cd "$PROJECT_DIR"
exec npm run dev -- --class=head-terminal-dev "${KEYRING_ARGS[@]}" >>"$LOG_FILE" 2>&1
