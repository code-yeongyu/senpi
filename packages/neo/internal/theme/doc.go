// Package theme holds the neo TUI's palette and lipgloss styles, transcribed
// exactly from the grok build CLI captures (surfaces, text tiers, accents,
// borders, spinner frames, tool-row glyphs). It loads themes honoring
// settings.json `theme` and custom themes in ~/.senpi/agent/themes, with
// grok-night as the neo default.
//
// Colors are 24-bit truecolor and are never approximated: every hex is the
// value the real grok TUI emitted, cross-checked by golden tests that re-derive
// the same hexes from the captures and assert the rendered cells match, running
// through the xterm.js evidence harness (../../qa/xterm-render.mjs). NO_COLOR
// and 256-color terminals are served via the profile downgrade in RenderAt.
package theme
