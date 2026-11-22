/**
 * Grok glyphs for the `--grok-neo` mode (todo S2).
 *
 * The `grok-night` / `grok-day` theme JSONs carry the palette colours themselves;
 * `test/grok/grok-themes.test.ts` checks their §Palette hex values through the real
 * theme loader. This module keeps only the glyphs, which have no theme-file home.
 * Per the project's binding independent-reimplementation policy, it was written
 * without opening or referencing any grok-build source.
 */

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
