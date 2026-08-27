/**
 * WSL appends the Windows PATH, so `command -v cursor-agent` happily returns
 * `/mnt/c/Users/.../cursor-agent.cmd`. A Unix shell then tries to parse the
 * batch file (`@echo: not found`). Same for `.exe` on a Windows drive: the
 * pane lives in the distro and needs a Linux CLI.
 *
 * Git Bash uses `/c/Users/...`, not `/mnt/c/`, so native Windows .exe still
 * matches. `/mnt/wsl/` is three letters after `mnt/` and is not rejected.
 */
export const WINDOWS_INTEROP_CLI_GLOB = "*.cmd|*.bat|*.ps1|/mnt/[a-z]/*";

/**
 * Official Linux installers drop `claude` / `cursor-agent` / `codex` in
 * `~/.local/bin`. Login zsh does not read bashrc, so that directory is often
 * missing from PATH even when the binaries exist.
 */
export const UNIX_USER_BIN_PATH_EXPORT =
  'export PATH="$HOME/.local/bin:$PATH"';

/** zsh/bash function: exit 0 iff `$1` resolves to a Unix-native CLI. */
export const HT_UNIX_CMD_FN =
  "ht_unix_cmd() { "
  + "p=$(command -v \"$1\" 2>/dev/null) || return 1; "
  + "p=$(printf %s \"$p\" | tr '[:upper:]' '[:lower:]'); "
  + `case "$p" in ${WINDOWS_INTEROP_CLI_GLOB}) return 1 ;; esac; `
  + "return 0; }; ";
