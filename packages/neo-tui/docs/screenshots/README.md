# senpi-neo-tui screenshots

Live captures of `senpi --neo` (Rust + ratatui frontend) inside tmux. The TUI
auto-adapts: header / chat / input / footer at every size and a braille spinner
animates in the footer at ~12 fps. Overlays (help, slash, palette) render on top
via `Clear` + a centred bordered `Block` and feed selections back through the
same keymap dispatch path as direct keychords.

## Baseline scenes (demo)

| File | Viewport | Notes |
| --- | --- | --- |
| `01-narrow-80x24.png` | 80 × 24 | minimum supported; sidebar collapsed, footer compacts to status + tps |
| `02-mid-120x40.png` | 120 × 40 | sidebar threshold; tool card and chat full width |
| `03-mid-140x40.png` | 140 × 40 | typical laptop pane (direct binary) |
| `04-wide-160x50.png` | 160 × 50 | ultrawide / fullscreen; same content, more breathing room |
| `05-senpi-neo-e2e-140x40.png` | 140 × 40 | demo baseline captured with the direct Rust binary at the e2e viewport size |

## Overlay states (demo scene)

Captured by spawning `senpi-neo-tui --demo --demo-seconds 600` and sending the
keystrokes needed to open each overlay. The overlays render on top of the
bundled demo scene; these captures do not exercise the faux RPC backend.

| File | Viewport | Notes |
| --- | --- | --- |
| `06-help-overlay-140x40.png` | 140 × 40 | `?` opens the auto-generated keybinding cheat sheet (~75 entries) |
| `07-slash-menu-140x40.png` | 140 × 40 | leading `/` on an empty input buffer opens the grok-style slash menu (8 entries) |
| `08-palette-overlay-140x40.png` | 140 × 40 | `alt+p` opens the opencode-style command palette (every action_id + slash command, fuzzy-ranked by nucleo-matcher) |
| `09-palette-filter-help-140x40.png` | 140 × 40 | palette open + typing `help` filters to help-related entries (palette ranks via fuzzy match) |
| `10-slash-filter-mod-140x40.png` | 140 × 40 | slash menu open + typing `mod` filters to `/model` only |

## Pipeline

`scripts/capture-screenshots.sh` drives the canonical capture flow:

1. fresh tmux session at exact `WxH` (`-x 140 -y 40`)
2. spawn `senpi-neo-tui --demo --demo-seconds 600`
3. send the keystrokes needed to reach the target state
4. `tmux capture-pane -p -e -J` to dump the alt-screen with ANSI
5. `aha --no-header --black` to convert ANSI to standalone HTML
6. `chrome --headless --screenshot=...` to rasterize at the exact viewport
7. `tmux kill-session -t <name>` (NEVER `kill-server`)

The ANSI and HTML intermediates live in a temporary directory and are deleted by
the script's cleanup trap. The checked-in artifact is the regenerated PNG set
under this directory.
