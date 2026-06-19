#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_BIN="$ROOT/src-tauri/target/debug/head-terminal-dev"

if [[ ! -x "$DEV_BIN" ]]; then
  echo "Binário dev não encontrado. Rode: npm run build:dev" >&2
  exit 1
fi

exec "$DEV_BIN"
