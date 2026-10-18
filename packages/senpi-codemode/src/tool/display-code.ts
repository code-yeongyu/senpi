import { bunJsPrinter, prettifyJs } from "./display-js.ts";
import { pythonDisplay } from "./display-python.ts";
import type { EvalLanguage } from "./types.ts";

// Display-only (senpi#2050, senpi#2076): models often send a cell as one long line of joined
// statements. The tool arguments are never touched (senpi#1472).
const DENSE_LINE_LENGTH = 100;
const CACHE_LIMIT = 64;

const jsCache = new Map<string, string>();

function isDense(code: string): boolean {
	return code.split("\n").some((line) => line.length > DENSE_LINE_LENGTH);
}

function displayJs(code: string): string {
	const print = bunJsPrinter();
	if (print === null) return code;
	const cached = jsCache.get(code);
	if (cached !== undefined) return cached;
	const formatted = prettifyJs(code, print) ?? code;
	if (jsCache.size >= CACHE_LIMIT) jsCache.delete(jsCache.keys().next().value ?? "");
	jsCache.set(code, formatted);
	return formatted;
}

/**
 * The preview text for a cell. Dense JavaScript is laid out by the built-in Bun printer only when
 * the renderer runs on Bun; dense Python is formatted by the user's own interpreter in the
 * background, so the first render shows the cell as sent and `onFormatted` asks for a repaint.
 * Pass `onFormatted` only for complete code; without it no formatter process starts.
 */
export function displayCode(code: string, language: EvalLanguage, onFormatted?: () => void): string {
	if (!isDense(code)) return code;
	switch (language) {
		case "js":
			return displayJs(code);
		case "py":
			return pythonDisplay.display(code, onFormatted);
		case "rb":
		case "jl":
			return code;
		default: {
			const unreachable: never = language;
			return unreachable;
		}
	}
}
