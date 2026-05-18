#!/usr/bin/env bash
# capture-screenshots.sh
#
# Drives the senpi-neo-tui binary through canonical interactive states inside
# tmux and renders each captured pane to a PNG. Used to regenerate the marketing
# screenshots under docs/screenshots/ whenever the demo scene or overlays change.
#
# Pipeline per state:
#   1. fresh tmux session at exact WxH
#   2. spawn senpi-neo-tui (demo mode or with senpi-neo-faux as RPC backend)
#   3. send keystrokes to reach the target state
#   4. tmux capture-pane -p -e  -> ANSI text with 24-bit colour
#   5. aha --no-header          -> standalone HTML
#   6. Chrome headless          -> PNG at exact viewport
#   7. kill the tmux session (NEVER kill-server; only kill-session)
#
# Requires: tmux, aha, /Applications/Google\ Chrome.app

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TUI_BIN="${REPO_ROOT}/target/release/senpi-neo-tui"
FAUX_BIN="${REPO_ROOT}/target/release/senpi-neo-faux"
OUT_DIR="${REPO_ROOT}/packages/neo-tui/docs/screenshots"
WORK_DIR="$(mktemp -d -t senpi-neo-shots.XXXXXX)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [[ ! -x "$TUI_BIN" ]]; then
  echo "missing $TUI_BIN - run cargo build --release --package senpi-neo-tui --bins" >&2
  exit 1
fi
if [[ ! -x "$FAUX_BIN" ]]; then
  echo "missing $FAUX_BIN - run cargo build --release --package senpi-neo-tui --bins" >&2
  exit 1
fi

cleanup() {
  for s in $(tmux ls 2>/dev/null | awk -F: '/^senpi-neo-shot/ {print $1}'); do
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
    cat <<EOF
<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#0b0e14}
pre{
  font-family: "JetBrains Mono","SF Mono","Menlo","Consolas",monospace;
  font-size: 14px;
  line-height: 18px;
  letter-spacing: 0;
  color: #d1d8e0;
  background: #0b0e14;
  padding: 12px 16px;
  margin: 0;
  white-space: pre;
}
</style></head><body>
EOF
    aha --no-header --black < "$txt"
    echo "</body></html>"
  } > "$html"

  local pixel_w=$((width * cell_w + pad_x))
  local pixel_h=$((height * cell_h + pad_y))

  "$CHROME" \
    --headless \
    --disable-gpu \
    --hide-scrollbars \
    --no-sandbox \
    --force-device-scale-factor=2 \
    --window-size="${pixel_w},${pixel_h}" \
    --screenshot="$out_png" \
    "file://$html" >/dev/null 2>&1

  if [[ ! -s "$out_png" ]]; then
    echo "capture failed for $out_png" >&2
    exit 1
  fi
}

new_session() {
  local name="$1"
  local width="$2"
  local height="$3"
  tmux kill-session -t "$name" 2>/dev/null || true
  TERM=xterm-256color tmux new-session -d -s "$name" -x "$width" -y "$height"
  # tmux defaults to 8 colour; force 24-bit so themes render true.
  tmux set-option -t "$name" -g default-terminal "tmux-256color" >/dev/null
  tmux set-option -t "$name" -ga terminal-overrides ",*:RGB" >/dev/null
}

send_keys() {
  local name="$1"
  shift
  tmux send-keys -t "$name" "$@"
}

# ----- Scenarios -----

shot_baseline() {
  local label="$1"
  local w="$2"
  local h="$3"
  local out="$4"
  local name="senpi-neo-shot-${label}"
  new_session "$name" "$w" "$h"
  send_keys "$name" "$TUI_BIN --demo --demo-seconds 600" Enter
  sleep 1.4
  render_pane "$name" "$w" "$h" "${OUT_DIR}/${out}"
  tmux kill-session -t "$name" 2>/dev/null || true
}

shot_help() {
  local name="senpi-neo-shot-help"
  local w=140
  local h=40
  new_session "$name" "$w" "$h"
  send_keys "$name" "$TUI_BIN --demo --demo-seconds 600" Enter
  sleep 1.2
  # ctrl+? -> help overlay
  tmux send-keys -t "$name" "C-?"
  sleep 0.4
  render_pane "$name" "$w" "$h" "${OUT_DIR}/06-help-overlay-140x40.png"
  tmux kill-session -t "$name" 2>/dev/null || true
}

shot_slash() {
  local name="senpi-neo-shot-slash"
  local w=140
  local h=40
  new_session "$name" "$w" "$h"
  send_keys "$name" "$TUI_BIN --demo --demo-seconds 600" Enter
  sleep 1.2
  # leading slash on empty buffer -> SlashOverlay
  tmux send-keys -t "$name" "/"
  sleep 0.4
  render_pane "$name" "$w" "$h" "${OUT_DIR}/07-slash-menu-140x40.png"
  tmux kill-session -t "$name" 2>/dev/null || true
}

shot_palette() {
  local name="senpi-neo-shot-palette"
  local w=140
  local h=40
  new_session "$name" "$w" "$h"
  send_keys "$name" "$TUI_BIN --demo --demo-seconds 600" Enter
  sleep 1.2
  # alt+p -> palette overlay
  tmux send-keys -t "$name" "M-p"
  sleep 0.4
  render_pane "$name" "$w" "$h" "${OUT_DIR}/08-palette-overlay-140x40.png"
  tmux kill-session -t "$name" 2>/dev/null || true
}

shot_palette_filter() {
  local name="senpi-neo-shot-palette-filter"
  local w=140
  local h=40
  new_session "$name" "$w" "$h"
  send_keys "$name" "$TUI_BIN --demo --demo-seconds 600" Enter
  sleep 1.2
  tmux send-keys -t "$name" "M-p"
  sleep 0.3
  tmux send-keys -t "$name" "help"
  sleep 0.4
  render_pane "$name" "$w" "$h" "${OUT_DIR}/09-palette-filter-help-140x40.png"
  tmux kill-session -t "$name" 2>/dev/null || true
}

shot_slash_filter() {
  local name="senpi-neo-shot-slash-filter"
  local w=140
  local h=40
  new_session "$name" "$w" "$h"
  send_keys "$name" "$TUI_BIN --demo --demo-seconds 600" Enter
  sleep 1.2
  tmux send-keys -t "$name" "/"
  sleep 0.3
  tmux send-keys -t "$name" "mod"
  sleep 0.4
  render_pane "$name" "$w" "$h" "${OUT_DIR}/10-slash-filter-mod-140x40.png"
  tmux kill-session -t "$name" 2>/dev/null || true
}

main() {
  mkdir -p "$OUT_DIR"
  shot_baseline narrow   80  24 01-narrow-80x24.png
  shot_baseline mid120  120  40 02-mid-120x40.png
  shot_baseline mid140  140  40 03-mid-140x40.png
  shot_baseline wide    160  50 04-wide-160x50.png
  shot_baseline e2e     140  40 05-senpi-neo-e2e-140x40.png
  shot_help
  shot_slash
  shot_palette
  shot_palette_filter
  shot_slash_filter
  echo "Captured PNGs under ${OUT_DIR}"
  ls -1 "${OUT_DIR}" | grep -E '^(0[1-9]|10)-'
}

main "$@"
