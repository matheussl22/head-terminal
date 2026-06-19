#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON="$ROOT/src-tauri/icons/128x128.png"
DEV_LAUNCHER="$ROOT/scripts/head-terminal-dev.sh"
RELEASE_LAUNCHER="$ROOT/scripts/head-terminal-release.sh"
RELEASE_BIN="$ROOT/src-tauri/target/release/head-terminal"

install_entry() {
  local file_name="$1"
  local name="$2"
  local exec_path="$3"
  local wm_class="$4"
  local desktop_file="$DESKTOP_DIR/$file_name"

  cat > "$desktop_file" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=$name
GenericName=Terminal
Comment=Terminal focado em AI coding agents
Exec=$exec_path
Icon=$ICON
Terminal=false
Categories=Development;Utility;
Keywords=terminal;agent;cursor;ai;developer;
StartupNotify=true
StartupWMClass=$wm_class
EOF

  echo "Atalho instalado: $desktop_file"
}

mkdir -p "$DESKTOP_DIR"
chmod +x "$DEV_LAUNCHER" "$RELEASE_LAUNCHER"

install_entry \
  "head-terminal-dev.desktop" \
  "Head Terminal (Dev)" \
  "$DEV_LAUNCHER" \
  "com.matheus.head-terminal.dev"

if [[ -x "$RELEASE_BIN" ]]; then
  install_entry \
    "head-terminal.desktop" \
    "Head Terminal" \
    "$RELEASE_LAUNCHER" \
    "com.matheus.head-terminal"
else
  if [[ "${1:-}" == "--release" ]]; then
    echo "Binário de release não encontrado. Rode: npm run build:release" >&2
    exit 1
  fi

  echo "Release ainda não compilado — só o atalho Dev foi criado."
  echo "Para prod: npm run build:release && npm run install:desktop"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

echo ""
echo "Uso recomendado:"
echo "  Prod (estável, dogfooding): Head Terminal"
echo "  Dev (hot reload, mata PTY ao salvar): Head Terminal (Dev)"
