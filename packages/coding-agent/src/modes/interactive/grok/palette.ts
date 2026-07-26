/**
 * Grok palette — typed constants for the `--grok-neo` mode (todo S2).
 *
 * Source of truth: `.omo/plans/grok-neo.md` §Palette (authoritative embedded
 * data). The values were hand-transcribed from real terminal SGR captures —
 * they are measured colour data, not copied code. Per the project's binding
 * independent-reimplementation policy, this module was written without
 * opening or referencing any grok-build source.
 *
 * The `grok-night` / `grok-day` theme JSONs (todo G1) resolve their
 * §Palette-named keys from these values; the golden test
 * (`test/grok/palette-golden.test.ts`) re-derives every constant from the
 * plan table so drift fails loudly.
 */

/** A CSS-style `#rrggbb` hex colour. */
export type GrokHex = `#${string}`;

/** Surfaces — background tiers captured from the grok night UI. */
export const GROK_SURFACES = {
	/** Main background. */
	base: "#141414",
	/** Input / lower-panel background. */
	panel: "#111111",
	/** Menu / selection band. */
	highlight: "#242424",
	/** Alternating rows. */
	altRow: "#1c1c1c",
	/** Strong selection background. */
	selected: "#363636",
} as const satisfies Record<string, GrokHex>;

/** Text — foreground hierarchy, brightest to faintest. */
export const GROK_TEXT = {
	primary: "#e1e1e1",
	secondary: "#c8c8c8",
	muted: "#6c6c6c",
	dim: "#585858",
	faint: "#505058",
	label: "#808080",
} as const satisfies Record<string, GrokHex>;

/** Accents — shared status/emphasis accents. */
export const GROK_ACCENTS = {
	green: "#9ece6a",
	red: "#f7768e",
	blue: "#7aa2f7",
	yellow: "#e0af68",
	cyan: "#3a95ab",
} as const satisfies Record<string, GrokHex>;

/** Borders — per-surface border colours. */
export const GROK_BORDERS = {
	input: "#505058",
	card: "#333333",
	modal: "#585858",
} as const satisfies Record<string, GrokHex>;

/** Grok Night — the six accent slots of the night theme. */
export const GROK_NIGHT = {
	magenta: "#bb9af7",
	blue: "#7aa2f7",
	cyan: "#73daca",
	fg: "#c0caf5",
	green: "#9ece6a",
	red: "#f7768e",
} as const satisfies Record<string, GrokHex>;

/** Grok Day — the accent slots of the day theme. */
export const GROK_DAY = {
	blue: "#2F64D2",
	red: "#CD3048",
	green: "#0C947C",
} as const satisfies Record<string, GrokHex>;

/** Glyphs — spinner frame and tool-row guide/marker runes. */
export const GROK_GLYPHS = {
	/** Braille spinner frame (one of the braille set). */
	spinner: "⠹",
	/** Tool-row glyphs: guide `┃` + marker `◆`. */
	toolRow: "┃ ◆",
	/** Tool-row vertical guide. */
	toolRowGuide: "┃",
	/** Tool-row marker diamond. */
	toolRowMarker: "◆",
} as const;

/** Reference terminal widths the palette was captured/QA'd at. */
export const GROK_REFERENCE_SIZES = [
	{ cols: 120, rows: 36 },
	{ cols: 80, rows: 24 },
] as const;

/** Aggregate view of the full palette, mirroring the plan's §Palette table. */
export const GROK_PALETTE = {
	surfaces: GROK_SURFACES,
	text: GROK_TEXT,
	accents: GROK_ACCENTS,
	borders: GROK_BORDERS,
	grokNight: GROK_NIGHT,
	grokDay: GROK_DAY,
	glyphs: GROK_GLYPHS,
} as const;
