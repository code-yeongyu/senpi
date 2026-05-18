# senpi-neo-tui screenshots

Live captures of `senpi --neo` (Rust + ratatui frontend) running the bundled
demo scene in tmux. The TUI auto-adapts: header / chat / input / footer at every
size, sidebar surfaces at ≥120 columns, knight-rider streaming bar and braille
spinner animate at 30 fps.

| File | Viewport | Notes |
| --- | --- | --- |
| `01-narrow-80x24.png` | 80 × 24 | minimum supported; sidebar collapsed, footer compacts to status + tps |
| `02-mid-120x40.png` | 120 × 40 | sidebar threshold; tool card and chat full width |
| `03-mid-140x40.png` | 140 × 40 | typical laptop pane |
| `04-wide-160x50.png` | 160 × 50 | ultrawide / fullscreen; same content, more breathing room |

Pipeline: tmux capture-pane (with `-e` to keep ANSI) → `aha --no-header` (ANSI to
HTML with 24-bit color) → Chrome headless (`--screenshot`) at the exact viewport.
Source ANSI / HTML / TXT for each size live under `evidence/screenshots/` in the
worktree (locally ignored — regenerate via the QA pipeline whenever the demo
scene changes).
