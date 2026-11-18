#!/bin/bash
set -euo pipefail

apt_etc="${APT_ETC_DIR:-/etc/apt}"

# --cache-key prints the actions/cache key for this package set on this runner image (senpi#4552).
# The image version is part of it: a .deb set downloaded for one image must never be installed on another,
# where dpkg would silently downgrade libraries the image already ships newer.
if [ "${1:-}" = "--cache-key" ]; then
  shift
  packages_hash=$(printf '%s\n' "$@" | { sha256sum 2> /dev/null || shasum -a 256; } | cut -c1-16)
  echo "key=apt-debs-${ImageOS:-unknown}-${ImageVersion:-unknown}-$(uname -m)-$packages_hash"
  exit 0
fi

deb_cache="${APT_DEB_CACHE_DIR:-}"

installed() {
  local package
  for package in "$@"; do
    [ "$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null)" = installed ] || return 1
  done
}

if [ -n "$deb_cache" ]; then
  mkdir -p "$deb_cache/partial"
  if compgen -G "$deb_cache/*.deb" > /dev/null; then
    # One dpkg call unpacks the whole set before configuring it, so dependencies inside the set resolve.
    # No transfer happens here, so the step's own timeout bounds it: killing dpkg midway would leave
    # the package database interrupted for the fallback below.
    if sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a dpkg -i "$deb_cache"/*.deb && installed "$@"; then
      echo "Installed $* from the cached .deb set; no mirror was contacted"
      exit 0
    fi
    echo "::warning::The cached .deb set did not install $*; downloading from the mirror instead"
    sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a dpkg --configure -a
    rm -f "$deb_cache"/*.deb
  fi
fi

# Bound the whole transfer, not just idle sockets: a slow mirror can keep making
# progress for minutes. Download first so a timeout never interrupts dpkg.
apt_run() {
  local budget="$1"
  shift
  sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a APT_ARCHIVES="$deb_cache" \
    timeout --kill-after=5s "$budget" "$@"
}

download() {
  local budget="$1"
  shift
  apt_run "$budget" bash -e -c '
    options=(-o Acquire::Retries=0 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15)
    if [ -n "$APT_ARCHIVES" ]; then options+=(-o "Dir::Cache::archives=$APT_ARCHIVES"); fi
    apt-get "${options[@]}" -o APT::Update::Error-Mode=any update
    apt-get "${options[@]}" --download-only install -y "$@"
  ' -- "$@"
}

if ! download 60s "$@"; then
  echo "::warning::APT transfer failed or exceeded 60s; retrying once via archive.ubuntu.com"
  # ubuntu-latest uses mirror+file: URLs; changing sources alone leaves the cloud region mirror
  # (azure.archive.ubuntu.com, us-east-2.ec2.archive.ubuntu.com, ...) first in apt-mirrors.txt.
  # Also handle older images with direct source URLs.
  for source in "$apt_etc/apt-mirrors.txt" "$apt_etc/sources.list" "$apt_etc"/sources.list.d/*.list "$apt_etc"/sources.list.d/*.sources; do
    if [ -f "$source" ]; then
      sudo sed -E -i 's#://[A-Za-z0-9.-]+\.archive\.ubuntu\.com#://archive.ubuntu.com#g' "$source"
    fi
  done
  download 150s "$@"
fi

apt_run 60s bash -e -c '
  options=()
  if [ -n "$APT_ARCHIVES" ]; then options+=(-o "Dir::Cache::archives=$APT_ARCHIVES"); fi
  apt-get "${options[@]}" --no-download install -y "$@"
' -- "$@"

# The runner's cache step saves the directory as the runner user after the job.
if [ -n "$deb_cache" ]; then
  sudo chown -R "$(id -u):$(id -g)" "$deb_cache"
fi
