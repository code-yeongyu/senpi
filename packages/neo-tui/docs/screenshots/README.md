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
| `05-senpi-neo-e2e-140x40.png` | 140 × 40 | end-to-end capture of `senpi --neo --demo` proving the Node → Rust dispatch path works |

## Overlay states (live RPC via faux backend)

Captured by spawning the binary with `SENPI_NEO_BACKEND_BIN` pointed at
`senpi-neo-faux --scenario streaming`, so the chat shows real RPC frames and
the overlay layer renders on top of a populated scene.

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
2. spawn `senpi-neo-tui` with `senpi-neo-faux` as the RPC backend
3. send the keystrokes needed to reach the target state
4. `tmux capture-pane -p -e -J` to dump the alt-screen with ANSI
5. `aha --no-header --black` to convert ANSI to standalone HTML
6. `chrome --headless --screenshot=...` to rasterize at the exact viewport
7. `tmux kill-session -t <name>` (NEVER `kill-server`)

Source ANSI / HTML for each size live under `evidence/screenshots/` in the
worktree (locally ignored — regenerate via the script whenever the demo scene
or overlay layout changes).
