> senpi can wear a different chrome. Ask it to show you around.

# Grok Neo Mode (Experimental)

`--grok-neo` is an experimental alternative presentation ("chrome") for the standard interactive mode. It runs the same agent, tools, sessions, and keybindings as the classic TUI — only the visual layer changes.

## How It Differs from the Classic TUI

The classic TUI renders a bordered editor, a multi-line footer with token and cost details, and expandable tool executions. The grok chrome replaces that presentation with:

- **Input card** — the editor sits inside a rounded card (`╭─╮` / `╰─╯` borders) with a themed interior background.
- **Compact footer** — model and working directory only; the detailed token/cost readout is intentionally omitted.
- **Welcome card** — startup shows the app name and version inside a bordered card.
- **Single-line tool rows** — tool executions render as one-line rows with a stable guide column (`┃`) and a diamond marker (`◆`).
- **Braille working indicator** — the spinner uses the braille frame `⠹`, tinted with the active theme's accent colour.

All chrome colours resolve through tokens backed by the active theme, so the chrome stays coherent with `grok-day` and with custom themes.

### Overlay Policy

Overlay options control placement, sizing, visibility, and focus; they do not carry presentation colours. Existing modal components render their own borders from the active theme. A modal using the standard `DynamicBorder` therefore inherits the active `border` token (`#585858` under `grok-night`); components that explicitly request an accent border keep that component-specific choice. The modal colour is supplied by the active theme, not by a grok overlay-options seam.

## Enabling the Mode

The mode is gated behind an environment variable and is **off by default**:

```bash
export SENPI_ENABLE_GROK_NEO=1   # also accepts "true" or "yes"
senpi --grok-neo
```

Or for a single run:

```bash
SENPI_ENABLE_GROK_NEO=1 senpi --grok-neo
```

Without the gate, `--grok-neo` is absent from `--help` and parses as an unknown extension flag, exactly as if the feature did not exist.

## Themes

Two built-in themes ship with the mode:

- `grok-night` — dark palette (the fallback)
- `grok-day` — light palette

Theme selection follows one precedence rule: **an existing settings theme always wins.** `grok-night` is only an in-memory fallback used when no theme was ever chosen, and it is never written to `settings.json`. To use `grok-day` (or any other theme), select it explicitly via `/settings` or in `settings.json`:

```json
{
  "theme": "grok-day"
}
```

Once you select a theme it is persisted and takes precedence on every later launch.

Modal and overlay components resolve their border through the normal theme `border` token. Both Grok themes map that token to the §Palette modal value, `#585858`; the input and card values remain available through the other schema border slots.

Note that `--theme <path>` **registers** a theme file or directory as a resource; it does not select one. Selection always happens through `/settings` or `settings.json`.

Senpi is a rebranded distribution, so its first-time setup is intentionally unavailable: that flow only runs for the official Pi package/app/config identity. A fresh `--grok-neo` launch therefore reaches the normal in-memory `grok-night` fallback directly; it does not show a Grok-specific setup or persist a theme.

## Architecture: One Process

`--grok-neo` runs **in-process**: the chrome is a presentation strategy inside the ordinary interactive mode, in the same senpi process. There is no separate binary and no daemon — unlike the retired `--neo`, which launched a Go TUI binary talking to senpi over a JSONL RPC daemon.

For the Bun-compiled binary (`npm run build:binary`) this means one process and one deployable directory. `bun build --compile` produces a single `dist/pi` executable, and its runtime assets ship alongside it in `dist/`: theme JSON files, image assets, the photon WASM module, and the pty native addon. Native `.node` addons are **not** embedded by `bun build --compile`; the pty addon is resolved as a sidecar relative to the executable (`dist/native/prebuilds/<platform-arch>/`). So the honest claim is "one process, one deployable directory" — not one file.

## Experimental Status

The mode is experimental: it is gated off by default, and its visuals and behaviour may change between releases. The classic TUI is unchanged and remains the default.

## Licence and Attribution

This mode is an **independent reimplementation** inspired by the style and techniques of [grok-build](https://github.com/xai-org/grok-build). grok-build is licensed under Apache-2.0; regardless of what that licence permits, no grok-build code was copied or translated into this project. The colour palette is colour data measured from terminal captures, not copied code.

This project is not affiliated with or endorsed by xAI.
