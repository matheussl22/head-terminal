#!/usr/bin/env bash
# Instala o pacote local em /Applications e reabre o app se ele estava aberto.
# Uso: npm run install:mac            (empacota e instala)
#      npm run install:mac:existing   (só instala o que já está em out/)
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install:mac só faz sentido no macOS." >&2
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Head Terminal.app"
SOURCE="$PROJECT_DIR/out/Head Terminal-darwin-$(uname -m)/$APP_NAME"
TARGET="/Applications/$APP_NAME"

if [[ ! -d "$SOURCE" ]]; then
  echo "Pacote ausente em $SOURCE. Rode: npm run package" >&2
  exit 1
fi

was_running=0
if pgrep -f "$TARGET/Contents/MacOS/head-terminal" >/dev/null 2>&1; then
  was_running=1
  # Pedir ao app para fechar: ele salva o workspace e confirma se houver agent
  # rodando. Só derruba na marra se não fechar em tempo razoável.
  osascript -e 'tell application "Head Terminal" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do
    pgrep -f "$TARGET/Contents/MacOS/head-terminal" >/dev/null 2>&1 || break
    sleep 0.25
  done
  pkill -f "$TARGET/Contents/MacOS/head-terminal" >/dev/null 2>&1 || true
fi

rm -rf "$TARGET"
cp -R "$SOURCE" "$TARGET"
# Sem assinatura de desenvolvedor o Gatekeeper trava o primeiro aberto.
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

echo "Instalado em $TARGET ($(defaults read "$TARGET/Contents/Info.plist" CFBundleShortVersionString))"

if [[ "$was_running" == "1" ]]; then
  open "$TARGET"
  echo "Reaberto."
fi
