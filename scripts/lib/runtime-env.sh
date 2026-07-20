#!/usr/bin/env bash

ensure_display() {
  if [[ -n "${DISPLAY:-}" ]]; then
    return
  fi

  if [[ -S /tmp/.X11-unix/X1 ]]; then
    export DISPLAY=:1
    return
  fi

  if [[ -S /tmp/.X11-unix/X0 ]]; then
    export DISPLAY=:0
  fi
}

ensure_log_dir() {
  local log_dir="$HOME/.local/share/head-terminal/logs"
  mkdir -p "$log_dir"
  printf '%s\n' "$log_dir"
}
