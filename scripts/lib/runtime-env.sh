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

# O Chromium inicializa o OSCrypt antes de qualquer janela e, com o backend
# gnome-libsecret, fica bloqueado para sempre quando o chaveiro "login" está
# trancado e ninguém responde ao prompt de desbloqueio: o app sobe sem janela e
# sem erro. Detectado aqui, ele começa com armazenamento em texto simples — o
# SecretService recusa esse backend, então nada é gravado sem criptografia.
keyring_fallback_args() {
  command -v dbus-send >/dev/null 2>&1 || return 0
  local locked status
  locked="$(timeout 3 dbus-send --session --print-reply=literal \
    --dest=org.freedesktop.secrets /org/freedesktop/secrets/collection/login \
    org.freedesktop.DBus.Properties.Get \
    string:org.freedesktop.Secret.Collection string:Locked 2>/dev/null)"
  status=$?
  # 124 = a própria consulta travou; sem serviço (outro status) o Chromium
  # escolhe outro backend e não trava, então nada muda.
  if [[ $status -eq 124 || "$locked" == *true* ]]; then
    printf '%s\n' "--password-store=basic"
  fi
}
