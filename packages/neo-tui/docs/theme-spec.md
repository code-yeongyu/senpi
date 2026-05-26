# senpi-neo-tui theme spec

Theme files are JSON documents loaded by `packages/neo-tui/src/theme/mod.rs`.
Bundled themes are compiled into the Rust binary with `include_str!`; the build
script does not copy theme JSON into `packages/coding-agent/dist`.

## Top-level shape

```json
{
  "$schema": "https://senpi.dev/neo-tui-theme.json",
  "name": "senpi-neo-dark",
  "type": "dark",
  "defs": {
    "espresso": "#1A1B26"
  },
  "tokens": {
    "background": "espresso",
    "primary": "#FF9E64"
  },
  "options": {
    "thinkingOpacityPercent": 60,
    "useNerdFonts": false,
    "supportsTrueColor": true
  }
}
```

| Field | Required | Runtime behavior |
| --- | --- | --- |
| `name` | yes | Stored on `ResolvedTheme.name`; also used as the current theme id in picker state. |
| `type` | no | `dark` or `light`; defaults to `dark`. |
| `defs` | no | Named color aliases. Values must be hex colors. |
| `tokens` | yes | Semantic token map. Each value is either a key from `defs` or a direct hex color. |
| `options.thinkingOpacityPercent` | no | Clamped to `0..=100` and resolved to a `0.0..=1.0` opacity. Defaults to `60`. |
| `options.useNerdFonts` | no | Parsed for schema compatibility; not currently used by render paths. |
| `options.supportsTrueColor` | no | Parsed as a theme hint; terminal true-color detection is not implemented here. |

## Tokens

The renderer expects every member of `Token::ALL` from
`packages/neo-tui/src/theme/mod.rs`. Missing or unparseable tokens fail theme
resolution in tests; direct runtime lookups fall back to `Color::Reset` instead
of panicking.

Token names are camelCase. The bundled dark theme is the canonical example:
`packages/neo-tui/assets/themes/senpi-neo-dark.json`.

## Bundled opencode themes

`packages/neo-tui/src/theme/registry.rs` derives the 15 bundled opencode themes
from their upstream palette JSON. Both flat ids (`dracula`) and namespaced ids
(`opencode/dracula`) are accepted by `--theme`; `--list-themes` prints the flat
ids plus `senpi-neo-dark`.
