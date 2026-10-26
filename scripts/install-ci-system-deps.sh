#!/bin/bash
set -euo pipefail

apt_etc="${APT_ETC_DIR:-/etc/apt}"

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
  echo "::warning::APT transfer failed or exceeded 60s; retrying once via archive.ubuntu.com"
  # ubuntu-latest uses mirror+file: URLs; changing sources alone leaves Azure
  # first in apt-mirrors.txt. Also handle older images with direct source URLs.
  for source in "$apt_etc/apt-mirrors.txt" "$apt_etc/sources.list" "$apt_etc"/sources.list.d/*.list "$apt_etc"/sources.list.d/*.sources; do
    if [ -f "$source" ]; then
      sudo sed -i 's|azure\.archive\.ubuntu\.com|archive.ubuntu.com|g' "$source"
    fi
  done
  download 150s "$@"
fi

sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
  timeout --kill-after=5s 60s apt-get --no-download install -y "$@"
