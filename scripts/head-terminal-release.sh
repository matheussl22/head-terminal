#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$PROJECT_DIR/scripts/lib/runtime-env.sh"

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

case "$(uname -s)" in
  Linux)
    RELEASE_BINARY="$PROJECT_DIR/out/Head Terminal-linux-x64/head-terminal"
    RELEASE_ARGS=("--class=head-terminal")
    ;;
  Darwin)
    RELEASE_BINARY="$PROJECT_DIR/out/Head Terminal-darwin-$(uname -m)/Head Terminal.app/Contents/MacOS/head-terminal"
    RELEASE_ARGS=()
    ;;
  *)
    notify_error "Launcher local não configurado para esta plataforma. Use o artefato criado por npm run make."
    exit 1
    ;;
esac

if [[ ! -x "$RELEASE_BINARY" ]]; then
  notify_error "Pacote Electron não encontrado. Rode no projeto: npm run package"
  exit 1
fi

ensure_display
LOG_DIR="$(ensure_log_dir)"
LOG_FILE="$LOG_DIR/prod.log"
export HEAD_TERMINAL_CHANNEL="prod"

mapfile -t KEYRING_ARGS < <(keyring_fallback_args)

echo "----- $(date -Is) electron:prod bin=$RELEASE_BINARY DISPLAY=${DISPLAY:-wayland} keyring=${KEYRING_ARGS[*]:-ok} -----" >>"$LOG_FILE"
exec "$RELEASE_BINARY" "${RELEASE_ARGS[@]}" "${KEYRING_ARGS[@]}" >>"$LOG_FILE" 2>&1
