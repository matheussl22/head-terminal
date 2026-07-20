# Shared environment for GUI launches, which normally do not source shell rc files.
# Source this file from a launcher; do not execute it directly.

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  source "$NVM_DIR/nvm.sh"
  nvm use --silent default 2>/dev/null || nvm use --silent node 2>/dev/null || true
fi

# When nvm was not initialized, use the newest installed Node 20+.
node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0')"
fi
if (( node_major < 20 )); then
  latest_node="$(find "$NVM_DIR/versions/node" -mindepth 1 -maxdepth 1 -type d -name 'v*' 2>/dev/null | sort -V | tail -n 1)"
  if [[ -n "$latest_node" && -x "$latest_node/bin/node" ]]; then
    export PATH="$latest_node/bin:$PATH"
  fi
fi
