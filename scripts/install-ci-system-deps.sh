#!/bin/bash
set -euo pipefail

apt_etc="${APT_ETC_DIR:-/etc/apt}"
# Waits (seconds) before each retry after the archive.ubuntu.com fallback. A runner can lose DNS for
# several minutes; one immediate retry fails inside the same outage, so the retries back off.
retry_delays="30 60 120"

# Bound the whole transfer, not just idle sockets: a slow mirror can keep making
# progress for minutes. Download first so a timeout never interrupts dpkg.
download() {
  local budget="$1"
  shift
  sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
    timeout --kill-after=5s "$budget" bash -e -c '
      options=(-o Acquire::Retries=0 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15)
      apt-get "${options[@]}" -o APT::Update::Error-Mode=any update
      apt-get "${options[@]}" --download-only install -y "$@"
    ' -- "$@"
}

if ! download 60s "$@"; then
  echo "::warning::APT transfer failed or exceeded 60s; retrying via archive.ubuntu.com"
  # ubuntu-latest uses mirror+file: URLs; changing sources alone leaves Azure
  # first in apt-mirrors.txt. Also handle older images with direct source URLs.
  for source in "$apt_etc/apt-mirrors.txt" "$apt_etc/sources.list" "$apt_etc"/sources.list.d/*.list "$apt_etc"/sources.list.d/*.sources; do
    if [ -f "$source" ]; then
      sudo sed -i 's|azure\.archive\.ubuntu\.com|archive.ubuntu.com|g' "$source"
    fi
  done
  fetched=0
  for delay in 0 $retry_delays; do
    if [ "$delay" != 0 ]; then
      echo "::warning::APT transfer via archive.ubuntu.com failed; retrying in ${delay}s"
      sleep "$delay"
    fi
    if download 150s "$@"; then
      fetched=1
      break
    fi
  done
  if [ "$fetched" != 1 ]; then
    echo "::error::APT transfer failed after $(( $(wc -w <<<"$retry_delays") + 2 )) attempts"
    exit 100
  fi
fi

sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
  timeout --kill-after=5s 60s apt-get --no-download install -y "$@"
