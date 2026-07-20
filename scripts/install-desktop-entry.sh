#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON="$PROJECT_DIR/assets/icons/128x128.png"
DEV_LAUNCHER="$PROJECT_DIR/scripts/head-terminal-dev.sh"
RELEASE_LAUNCHER="$PROJECT_DIR/scripts/head-terminal-release.sh"
RELEASE_BINARY="$PROJECT_DIR/out/Head Terminal-linux-x64/head-terminal"
INSTALL_RELEASE=0

if [[ "${1:-}" == "--release" ]]; then
  INSTALL_RELEASE=1
fi

install_entry() {
  local file_name="$1"
  local name="$2"
  local exec_path="$3"
  local wm_class="$4"
  local desktop_file="$DESKTOP_DIR/$file_name"

  # Paths originate from the local checkout and may contain spaces.
  printf '%s\n' \
    '[Desktop Entry]' \
    'Type=Application' \
    'Version=1.0' \
    "Name=$name" \
    'GenericName=AI Agent Terminal' \
    'Comment=Terminal Electron para AI coding agents' \
    "Exec=\"$exec_path\"" \
    "Icon=$ICON" \
    'Terminal=false' \
    'Categories=Development;Utility;' \
    'Keywords=terminal;agent;claude;cursor;codex;ai;developer;' \
    'StartupNotify=true' \
    "StartupWMClass=$wm_class" \
    >"$desktop_file"

  chmod 0644 "$desktop_file"
  echo "Atalho instalado: $desktop_file"
}

mkdir -p "$DESKTOP_DIR"
chmod +x "$DEV_LAUNCHER" "$RELEASE_LAUNCHER"

install_entry \
  "head-terminal-dev.desktop" \
  "Head Terminal (Dev)" \
  "$DEV_LAUNCHER" \
  "head-terminal-dev"

if [[ -x "$RELEASE_BINARY" ]]; then
  install_entry \
    "head-terminal.desktop" \
    "Head Terminal" \
    "$RELEASE_LAUNCHER" \
    "head-terminal"
elif (( INSTALL_RELEASE == 1 )); then
  echo "Pacote Electron ausente. Rode: npm run package" >&2
  exit 1
else
  echo "Pacote de produção ausente; somente o launcher Dev foi instalado."
  echo "Para produção: npm run package && npm run install:desktop:release"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi
