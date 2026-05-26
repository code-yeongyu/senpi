# `senpi-neo-tui`

Native Rust + [ratatui](https://ratatui.rs) TUI for [senpi](https://github.com/code-yeongyu/senpi).

Launched via:

```bash
senpi --neo
```

The Node-side senpi CLI spawns the Rust binary, which owns the terminal directly and talks to the senpi runtime over the existing `senpi --mode rpc` JSONL protocol.

## Why a separate binary

A TUI needs exclusive ownership of the terminal: raw mode, alternate screen, Kitty keyboard protocol, mouse capture, panic-safe cleanup. Embedding a ratatui app inside the Node process through NAPI produces three classes of bug (ThreadsafeFunction event-loop leaks, libuv/tokio TTY races, panic-poisoned addon state). A standalone binary sidesteps all three. The pipe IPC cost is 50-200 µs per JSONL line: negligible against frame budgets.

## Run

The crate ships two bins (`senpi-neo-tui`, the TUI itself; `senpi-neo-faux`, the offline RPC backend used by the QA harness), so `cargo run` needs `--bin` to disambiguate.

```bash
# Dev: render the bundled demo scene
cargo run --release --package senpi-neo-tui --bin senpi-neo-tui -- \
    --demo --demo-seconds 5

# Through the Node CLI after `npm run build` has produced dist/cli.js
# (SENPI_NEO_TUI_DEV=1 makes it resolve target/release first):
SENPI_NEO_TUI_DEV=1 node packages/coding-agent/dist/cli.js --neo

# Offline QA with the faux backend (build both bins first):
cargo build --release --package senpi-neo-tui --bins
cargo run --release --package senpi-neo-tui --bin senpi-neo-tui -- \
    --backend-bin ./target/release/senpi-neo-faux
```

## CLI flags

These belong to the `senpi-neo-tui` binary. When you launch through `senpi --neo`, forward them after a `--` sentinel so the senpi CLI does not eat them (e.g. `senpi --neo` shares the spelling `--theme` with the Node CLI, which means something different there).

```bash
senpi --neo -- --theme opencode/dracula
senpi --neo -- --list-themes
senpi --neo -- --demo --demo-seconds 5
```

| Flag | Env | Description |
|------|-----|-------------|
| `--backend-bin <PATH>` | `SENPI_NEO_BACKEND_BIN` | Path to the senpi backend binary. Spawned with `--mode rpc` on startup; if unset, the TUI runs offline (demo mode or empty session). |
| `--backend-args <JSON>` | `SENPI_NEO_BACKEND_ARGS` | JSON array of extra args forwarded to the backend, e.g. `'["--mode","rpc"]'`. |
| `--demo` | `SENPI_NEO_DEMO` | Render the canned demo scene used for screenshots. |
| `--demo-seconds <N>` | — | Exit after `N` seconds in demo mode. `0` = until Ctrl-C. |
| `--theme <ID\|PATH>` | `SENPI_NEO_THEME` | Override the theme by bundled id (`senpi-neo-dark`, `opencode/dracula`, …) or by JSON file path. |
| `--list-themes` | — | Print bundled theme ids and exit. |

## Bundled themes

`senpi-neo-dark` (default) plus 15 opencode-flavoured themes under `opencode/`: `ayu`, `catppuccin`, `catppuccin-frappe`, `catppuccin-macchiato`, `dracula`, `everforest`, `github`, `gruvbox`, `kanagawa`, `monokai`, `nord`, `opencode`, `rosepine`, `tokyonight`, `vesper`. Pass any of them to `--theme` or set `SENPI_NEO_THEME`. Custom themes follow the JSON schema in [`docs/theme-spec.md`](./docs/theme-spec.md).

## Default keybindings

Configurable in [`assets/keymaps/default.json`](./assets/keymaps/default.json). The non-obvious ones:

| Action | Default |
|--------|---------|
| Insert newline in the composer | `Shift+Enter` (works inside tmux via xterm modifyOtherKeys mode 2) |
| Submit the message | `Enter` |
| Recall previous / next prompt | `Up` / `Down` (when the composer is empty, or while walking an active history cursor); otherwise moves the editor cursor |
| Open slash command menu | `/` then type |
| Open `@path` autocomplete | type `@` |
| Cycle thinking level | `Shift+Tab` |
| Open model picker | `Ctrl+L` |
| Open theme picker | `Alt+T` |
| Open help overlay | `?` |
| Open command palette | `Alt+P` |
| Compact session | `Alt+C` |
| Toggle sidebar | `Alt+S` |
| Toggle animations | `Alt+A` |
| Mouse wheel | scrolls the chat viewport |
| Cancel current run | `Esc` |
| Delete forward / quit | `Ctrl+D` deletes forward while the composer has content; with an empty composer it quits. Explicit `app.exit` actions such as `/quit` always quit. |

Full registry lives under the `bindings` map in the keymap JSON — every key is reassignable.

## Architecture

Process tree at runtime:

```
shell
└── node senpi --neo                  # transient parent
    └── senpi-neo-tui                 # Rust binary (owns TTY)
        └── node senpi --mode rpc     # backend
```

Module layout matches the `Layout` section below; per-module roles and the testing matrix live in [`AGENTS.md`](./AGENTS.md).

## Layout (modules)

- `app/`        - main loop, state, action channel, RPC bridge
- `rpc/`        - subprocess RPC client speaking senpi `--mode rpc` (JSONL), with `Inbound::{Error, Disconnected, ParseError}` surfacing
- `theme/`      - JSON theme loader, semantic tokens, bundled theme registry
- `keymap/`     - configurable single-key bindings; `leader` metadata is parsed but not dispatched
- `layout/`     - pure layout computation
- `compositor/` - layered `Component` dispatch + focus stack
- `components/` - chat, input, header, footer, markdown, autocomplete, select_list, settings_list
- `overlay/`    - help, model picker, theme picker, command palette
- `anim/`       - spinners, scanners, pulses
- `term/`       - terminal capability detection (Kitty / modifyOtherKeys / OSC 52)
- `text/`       - ANSI-aware visible_width / truncate / wrap / slice

## Tests

```bash
cargo test --package senpi-neo-tui
cargo clippy --package senpi-neo-tui --all-targets -- -D warnings
cargo fmt --package senpi-neo-tui -- --check
```

If `cargo-nextest` is installed locally, `cargo nextest run --package senpi-neo-tui` is also supported. There is no checked-in insta snapshot suite today.

## License

MIT.
