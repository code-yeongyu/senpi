#!/usr/bin/env bash
# capture-theme-showcase.sh
#
# Captures the demo scene under a handful of bundled themes so README/PR
# bodies can advertise the opencode-style multi-theme support without
# regenerating the main marketing screenshots.
#
# Output: packages/neo-tui/docs/screenshots/themes/<id>-140x40.png
#
# Requires: tmux, aha, /Applications/Google Chrome.app

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TUI_BIN="${REPO_ROOT}/target/release/senpi-neo-tui"
OUT_DIR="${REPO_ROOT}/packages/neo-tui/docs/screenshots/themes"
WORK_DIR="$(mktemp -d -t senpi-neo-themes.XXXXXX)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [[ ! -x "$TUI_BIN" ]]; then
  echo "missing $TUI_BIN - run cargo build --release --package senpi-neo-tui --bins" >&2
  exit 1
fi

cleanup() {
  for s in $(tmux ls 2>/dev/null | awk -F: '/^senpi-neo-theme/ {print $1}'); do
    tmux kill-session -t "$s" 2>/dev/null || true
  done
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

cell_w=8
cell_h=18
pad_x=24
pad_y=24

render_pane() {
  local session="$1"
  local width="$2"
  local height="$3"
  local out_png="$4"

  local txt="${WORK_DIR}/${session}.ansi"
  local html="${WORK_DIR}/${session}.html"

  tmux capture-pane -t "$session" -p -e -J > "$txt"

  {
    cat <<HTMLHEAD
<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: #0f1115; }
  pre {
    margin: 0;
    padding: ${pad_y}px ${pad_x}px;
    background: #0f1115;
    color: #d5d6db;
    font-family: 'JetBrainsMono Nerd Font', 'JetBrains Mono', 'SF Mono', 'Menlo', 'Consolas', monospace;
    font-size: 14px;
    line-height: ${cell_h}px;
    white-space: pre;
    letter-spacing: 0;
    font-variant-ligatures: none;
  }
</style>
<pre>
HTMLHEAD
    aha --no-header < "$txt"
    echo "</pre>"
  } > "$html"

  local viewport_w=$((width * cell_w + pad_x * 2))
  local viewport_h=$((height * cell_h + pad_y * 2))

  "$CHROME" \
    --headless=new \
    --no-sandbox \
    --hide-scrollbars \
    --disable-gpu \
    --force-device-scale-factor=2 \
    --window-size="${viewport_w},${viewport_h}" \
    --screenshot="$out_png" \
    "file://${html}" 2>/dev/null

  if [[ ! -s "$out_png" ]]; then
    echo "capture failed for $out_png" >&2
    exit 1
  fi
}

shot_theme() {
  local theme_id="$1"
  local w=140
  local h=40
  local name="senpi-neo-theme-${theme_id}"
  tmux kill-session -t "$name" 2>/dev/null || true
  TERM=xterm-256color tmux new-session -d -s "$name" -x "$w" -y "$h"
  tmux set-option -t "$name" -g default-terminal "tmux-256color" >/dev/null
  tmux set-option -t "$name" -ga terminal-overrides ",*:RGB" >/dev/null
  tmux send-keys -t "$name" "$TUI_BIN --demo --demo-seconds 600 --theme ${theme_id}" Enter
  sleep 1.4
  render_pane "$name" "$w" "$h" "${OUT_DIR}/${theme_id}-140x40.png"
  tmux kill-session -t "$name" 2>/dev/null || true
}

main() {
  mkdir -p "$OUT_DIR"
  shot_theme tokyonight
  shot_theme dracula
  shot_theme gruvbox
  shot_theme catppuccin
  shot_theme rosepine
  shot_theme nord
  shot_theme kanagawa
  shot_theme everforest
  echo "Captured theme showcase PNGs under ${OUT_DIR}"
  ls -1 "${OUT_DIR}"
}

main "$@"
