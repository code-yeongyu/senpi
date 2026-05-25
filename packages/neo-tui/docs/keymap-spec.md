# senpi-neo-tui keymap spec

The default keymap is `packages/neo-tui/assets/keymaps/default.json` and is
compiled into the Rust binary with `include_str!`. Runtime dispatch is
implemented in `packages/neo-tui/src/keymap/mod.rs` and `packages/neo-tui/src/app/mod.rs`.

## Top-level shape

```json
{
  "$schema": "https://senpi.dev/neo-tui-keymap.json",
  "version": 1,
  "leader": "space",
  "leaderTimeoutMs": 500,
  "bindings": {
    "tui.input.submit": ["enter"],
    "neo.palette.open": ["alt+p"]
  }
}
```

Only `bindings` affects dispatch today. `leader` and `leaderTimeoutMs` are
accepted by the parser for forward compatibility, but multi-stroke leader
sequences are not implemented.

## Binding ids

Binding ids are plain action strings. Existing namespaces are:

- `tui.editor.*` and `tui.input.*` for input/editor behavior.
- `tui.select.*` for overlays and select-list behavior.
- `app.*` for legacy senpi app actions routed through the backend or app state.
- `neo.*` for Rust-native additions such as theme picker, palette, help, and
  local history navigation.

Focus decides precedence. Input focus tries `tui.editor.*`, then `tui.input.*`,
then `app.*`; dialog focus tries `tui.select.*` first; `neo.*` is considered
last so it does not shadow the legacy contract.

## Chord grammar

A chord is one keypress, optionally prefixed by modifiers joined with `+`.
Modifier order is irrelevant and matching is case-insensitive.

Supported modifiers:

- `ctrl`
- `alt`, `meta`, `opt`, `option`
- `shift`
- `super`, `cmd`, `command`, `win`

Supported named keys include `enter`/`return`, `esc`/`escape`, `tab`,
`backtab`, `space`, `backspace`/`bs`, `delete`/`del`, `home`, `end`,
`pageup`/`pgup`, `pagedown`/`pgdn`, arrows, `insert`/`ins`, and `f1` through
`f12`. Single-character keys such as `/`, `?`, `]`, or `-` are also valid.

Examples: `ctrl+c`, `shift+tab`, `alt+enter`, `ctrl+]`, `ctrl+-`, `alt+p`.
