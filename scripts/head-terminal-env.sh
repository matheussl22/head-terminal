# Shared environment for GUI launches (GNOME does not source .bashrc/.zshrc).
# Sourced by launcher scripts — do not mark executable or run directly.

if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
  nvm use --silent default 2>/dev/null || nvm use --silent node 2>/dev/null || true
fi

# Fallback when nvm is not sourced: pick the newest installed Node 20+.
if ! command -v node >/dev/null 2>&1; then
  latest_nvm="$(ls -d "$HOME/.nvm/versions/node/"v* 2>/dev/null | sort -V | tail -1)"
  if [[ -n "$latest_nvm" && -x "$latest_nvm/bin/node" ]]; then
    export PATH="$latest_nvm/bin:$PATH"
  fi
elif [[ "$(node -p "process.versions.node.split('.')[0]")" -lt 20 ]]; then
  latest_nvm="$(ls -d "$HOME/.nvm/versions/node/"v* 2>/dev/null | sort -V | tail -1)"
  if [[ -n "$latest_nvm" && -x "$latest_nvm/bin/node" ]]; then
    export PATH="$latest_nvm/bin:$PATH"
  fi
fi
