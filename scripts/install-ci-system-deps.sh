#!/bin/bash
set -euo pipefail

apt_etc="${APT_ETC_DIR:-/etc/apt}"

# --cache-key prints the actions/cache key for this package set on this runner image (senpi#4552).
# The image version is part of it: package lists and .deb files fetched for one image must never be
# installed on another, where they would downgrade libraries the image already ships newer.
if [ "${1:-}" = "--cache-key" ]; then
  shift
  packages_hash=$(printf '%s\n' "$@" | { sha256sum 2> /dev/null || shasum -a 256; } | cut -c1-16)
  echo "key=apt-debs-${ImageOS:-unknown}-${ImageVersion:-unknown}-$(uname -m)-$packages_hash"
  exit 0
fi

# With APT_DEB_CACHE_DIR set, apt keeps its package lists and downloaded .deb files there, so the
# runner's cache step can hand both to the next run on the same image.
apt_cache="${APT_DEB_CACHE_DIR:-}"

# Bound the whole transfer, not just idle sockets: a slow mirror can keep making
# progress for minutes. Download first so a timeout never interrupts dpkg.
apt_run() {
  local budget="$1"
  shift
  sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a APT_CACHE="$apt_cache" \
    timeout --kill-after=5s "$budget" bash -e -c '
      options=(-o Acquire::Retries=0 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15)
      if [ -n "$APT_CACHE" ]; then
        options+=(-o "Dir::Cache::archives=$APT_CACHE/archives" -o "Dir::State::Lists=$APT_CACHE/lists")
      fi
      '"$1"'
    ' -- "${@:2}"
}

download() {
  apt_run "$1" 'apt-get "${options[@]}" -o APT::Update::Error-Mode=any update
    apt-get "${options[@]}" --download-only install -y "$@"' "${@:2}"
}

install_offline() {
  apt_run "$1" 'apt-get "${options[@]}" --no-download install -y "$@"' "${@:2}"
}

if [ -n "$apt_cache" ]; then
  mkdir -p "$apt_cache/archives/partial" "$apt_cache/lists/partial"
  if compgen -G "$apt_cache/archives/*.deb" > /dev/null; then
    if install_offline 120s "$@"; then
      echo "Installed $* from the cached package lists and .deb files; no mirror was contacted"
      sudo chown -R "$(id -u):$(id -g)" "$apt_cache"
      exit 0
    fi
    echo "::warning::The cached APT set did not install $*; downloading from the mirror instead"
    sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a dpkg --configure -a
    sudo rm -rf "$apt_cache/archives" "$apt_cache/lists"
    mkdir -p "$apt_cache/archives/partial" "$apt_cache/lists/partial"
  fi
fi

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

install_offline 60s "$@"

# The runner's cache step saves the directory as the runner user after the job.
if [ -n "$apt_cache" ]; then
  sudo chown -R "$(id -u):$(id -g)" "$apt_cache"
fi
