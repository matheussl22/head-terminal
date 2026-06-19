#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_BIN="$ROOT/src-tauri/target/release/head-terminal"

if [[ ! -x "$RELEASE_BIN" ]]; then
  echo "Binário de release não encontrado. Rode: npm run build:release" >&2
  exit 1
fi

# Release binary is self-contained; no Node/npm required.
exec "$RELEASE_BIN"
