import { highlightCode, type Theme } from "@code-yeongyu/senpi";
import { displayCode } from "./display-code.ts";
import type { EvalLanguage } from "./types.ts";

function languageForHighlighter(language: EvalLanguage): "python" | "javascript" | "ruby" | "julia" {
	switch (language) {
		case "py":
			return "python";
		case "js":
			return "javascript";
		case "rb":
			return "ruby";
		case "jl":
			return "julia";
		default: {
			const unreachable: never = language;
			throw new TypeError(`Unhandled eval language: ${String(unreachable)}`);
		}
	}
}

export function highlightedCode(
	code: string,
	language: EvalLanguage,
	theme: Theme | undefined,
	onFormatted?: () => void,
): string {
	const normalizedCode = code.trim().length > 0 ? code : "...";
	const lines = highlightCode(displayCode(normalizedCode, language, onFormatted), languageForHighlighter(language));
	return (theme === undefined ? lines.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, "")) : lines).join("\n");
}
