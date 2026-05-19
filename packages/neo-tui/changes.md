# changes.md — packages/neo-tui

This crate is net-new vs upstream `badlogic/pi-mono`. It exists only in the senpi fork.

## 2026-05-18 — Initial scaffold

- Created the workspace member `packages/neo-tui/` under the senpi monorepo.
- Workspace Cargo.toml at repo root introduces a Rust workspace alongside the existing TypeScript packages.
- The binary is built by `packages/neo-tui/scripts/build-binary.mjs` and copied into `packages/coding-agent/dist/neo-tui-bin/`.
- Activated only when the user passes `senpi --neo`. Zero impact on existing senpi behavior when the flag is absent.
- Talks to senpi over the existing `senpi --mode rpc` JSONL protocol (see `packages/coding-agent/docs/rpc.md`). No new RPC surface.

Upstream rebase notes: this directory does not exist upstream. Conflict surface is limited to the four touched files in `packages/coding-agent/` (args.ts, main.ts, modes/index.ts, package.json) which are tracked in `packages/coding-agent/src/cli/changes.md`.

## 2026-05-19 — Full pi-tui port + bug-fix rewrite (PR #14)

Threw out the early scaffold's renderer/editor/app loop and rebuilt them as a real ratatui app, porting features from `packages/tui` (TypeScript pi-tui) and pattern-matching `../codex/codex-rs/tui`. Re-skin to `../opencode` palette schema. 39 TDD-locked atomic commits.

Fixes 4 user-reported critical bugs:
1. `Shift+Enter` in tmux now inserts a newline (was: submit). Root cause was missing xterm modifyOtherKeys mode 2 (`\x1b[>4;2m`) on startup. New `term::TerminalCaps` emits it when `TMUX`/`TMUX_PANE` is set and includes `REPORT_ALL_KEYS_AS_ESCAPE_CODES` in the Kitty enhancement flags.
2. Korean / CJK input no longer truncates at the right edge of the input box. New `text::wrap_text_with_ansi` + `InputState::display_lines/cursor_visual_position` produce wrap-aware multi-line display with double-width handling.
3. Backend exit / EOF / parse errors no longer hang the UI silently. New `rpc::Inbound::{Error, Disconnected, ParseError}` variants are consumed by `app::apply_inbound`, surfacing a chat error bubble and `× backend disconnected` footer.
4. Idle vs answering states now visually distinct via per-`Status` background tints (`StatusIdleBg/BusyBg/StreamingBg/ToolBg/ErrorBg`) and metric-cluster hiding when all counters are zero.

New features bundled with the rewrite:
- `@<path>` autocomplete popup and `/` slash menu via new `Autocomplete` engine + reusable `SelectList`.
- Up/Down history navigation, mouse wheel chat scroll.
- Model picker + theme picker overlays.
- Markdown rendering (pulldown-cmark + syntect) in chat, every color via `Token::*`.
- Animation primitives (`anim::Spinner / Scanner / Pulse`).
- Connection status dot + model + thinking pill + branch dirty marker in header.
- Settings list component (toggle / cycle / submenu / static).

Test count: 298 passing (was 156 at branch start). `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test -j 1` all green. Theme audit confirms zero hardcoded `Color::Rgb` in render code.

## 2026-05-19 — Oracle blockers cleared (PR #14 follow-up)

- Added `diffAddedText` and `diffRemovedText` to `assets/themes/senpi-neo-dark.json` so the bundled dark theme defines every variant in `Token::ALL` (72/72). Locked by a new `bundled_dark_theme_resolves_every_token_in_token_all` assertion that scans the resolved theme for `Color::Reset` (the lenient fallback) and fails if any `Token::ALL` member is missing.
- Dropped the redundant `tui.editor.newLine` binding from `assets/keymaps/default.json`. The legacy `tui.input.newLine` (`shift+enter`) from `TUI_KEYBINDINGS` was already wired into the main key dispatcher, so the extra ID only existed to satisfy a shadow code path. Removing it kills the dispatch ambiguity and lets the keymap parity test stay green on both sides of the fence.
- Moved the neo-only `tui.input.historyPrev` / `tui.input.historyNext` bindings into the `neo.*` namespace (`neo.input.historyPrev` / `neo.input.historyNext`). The legacy senpi TUI does not have these bindings, so keeping them on `tui.*` was a future-conflict hazard; the parity tests on both sides now enforce the `neo.*` rule with zero exceptions.
