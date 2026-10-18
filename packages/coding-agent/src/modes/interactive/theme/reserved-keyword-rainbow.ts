import {
	type Color,
	type EditorKeywordHighlight,
	foregroundAnsi,
	mixColors,
	parseColor,
	type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { findReservedKeywordRuns } from "../../../core/reserved-keywords.ts";
import type { ThemeAppearance } from "./theme.ts";

interface SpectrumStop {
	readonly at: number;
	readonly color: Color;
}

function spectrum(hexes: readonly string[]): readonly SpectrumStop[] {
	const positions = [0, 0.18, 0.36, 0.54, 0.72, 0.9, 1];
	return hexes.map((hex, index) => ({ at: positions[index] ?? 1, color: parseColor(hex) }));
}

// The desktop composer's `.composer-reserved-keyword` stops: 700 shades on light surfaces,
// 400 shades on dark ones, so every stop clears 4.5:1 as text.
const SPECTRUM: Record<ThemeAppearance, readonly SpectrumStop[]> = {
	light: spectrum(["#b91c1c", "#c2410c", "#15803d", "#0f766e", "#1d4ed8", "#be185d", "#b91c1c"]),
	dark: spectrum(["#f87171", "#fbbf24", "#4ade80", "#2dd4bf", "#60a5fa", "#f472b6", "#f87171"]),
};

// A run spans red through pink; the final stop wraps back to red and is left out so the
// first and last characters of a keyword never share a colour.
const SPAN_END = 0.9;

export function reservedKeywordColor(appearance: ThemeAppearance, index: number, length: number): Color {
	const stops = SPECTRUM[appearance];
	const at = length <= 1 ? 0 : (Math.min(Math.max(index, 0), length - 1) / (length - 1)) * SPAN_END;
	for (let stop = 1; stop < stops.length; stop++) {
		const left = stops[stop - 1];
		const right = stops[stop];
		if (left === undefined || right === undefined || at > right.at) continue;
		const amount = right.at === left.at ? 0 : (at - left.at) / (right.at - left.at);
		return mixColors(left.color, right.color, amount, "srgb");
	}
	return stops[0]?.color ?? parseColor("#ffffff");
}

export interface ReservedKeywordHighlightSource {
	readonly appearance: () => ThemeAppearance;
	readonly colorMode: () => TerminalColorMode;
	readonly env?: NodeJS.ProcessEnv;
}

/** `NO_COLOR` (any non-empty value) turns the decoration off entirely. */
export function createReservedKeywordHighlight(
	source: ReservedKeywordHighlightSource,
): EditorKeywordHighlight | undefined {
	const noColor = (source.env ?? process.env).NO_COLOR;
	if (noColor !== undefined && noColor !== "") return undefined;
	const cache = new Map<string, string>();
	return {
		find: findReservedKeywordRuns,
		style: (text, index, length) => {
			const appearance = source.appearance();
			const mode = source.colorMode();
			const key = `${appearance}:${mode}:${index}:${length}`;
			let open = cache.get(key);
			if (open === undefined) {
				open = foregroundAnsi(reservedKeywordColor(appearance, index, length), mode);
				cache.set(key, open);
			}
			return `${open}${text}\x1b[39m`;
		},
	};
}
