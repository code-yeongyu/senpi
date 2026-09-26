import { scanBraces } from "./brace-scanner.ts";
import { composeFoldResult } from "./compose.ts";
import type { ReadFolder, ReadFolderInput, ReadFolderResult } from "./types.ts";

export * from "./types.ts";

/** Frozen measured selection, not a runtime registry that can enable unmeasured grammars. */
export const READ_FOLDER_SELECTION = Object.freeze({
	head: "6da8ef1361ef73928df8685e071f2a1826d3b17e",
	selectionSha256: "d7c502a1597e652f584877c0004ba6cde7c9393c8661ccbc388e3661ae66a634",
	wasm: true,
	rawReasons: Object.freeze({
		ts: "wasm_candidate_below_threshold",
		tsx: "wasm_candidate_below_threshold",
	} as const),
	languages: Object.freeze({
		ts: "raw",
		js: "wasm",
		json: "heuristic",
		tsx: "raw",
		python: "unsupported",
		rust: "unsupported",
		go: "unsupported",
		markdown: "prose_exempt",
		txt: "prose_exempt",
	} as const),
} as const);

export type ReadSummaryLanguage = keyof typeof READ_FOLDER_SELECTION.languages;
/** Every engine a frozen selection may name, independent of which ones the current receipt uses. */
export type ReadSummaryEngine = "raw" | "heuristic" | "wasm" | "unsupported" | "prose_exempt";
export function languageForPath(path: string): ReadSummaryLanguage | undefined {
	const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	if (!name.includes(".")) return undefined;
	switch (name.slice(name.lastIndexOf(".") + 1)) {
		case "ts":
			return "ts";
		case "js":
			return "js";
		case "json":
			return "json";
		case "tsx":
			return "tsx";
		case "py":
			return "python";
		case "rs":
			return "rust";
		case "go":
			return "go";
		case "md":
		case "markdown":
		case "mdown":
		case "mkd":
		case "mkdn":
			return "markdown";
		case "txt":
			return "txt";
		default:
			return undefined;
	}
}

/** The frozen engine for a path's language, independent of which folder object a caller supplies. */
export function readSummaryEngineForPath(path: string): ReadSummaryEngine | undefined {
	const language = languageForPath(path);
	if (language === undefined) return undefined;
	const engine: ReadSummaryEngine = READ_FOLDER_SELECTION.languages[language];
	return engine;
}

/** Reader eligibility stays bound to the frozen selection even with a custom folder. */
export function isReadSummaryPath(path: string): boolean {
	const engine = readSummaryEngineForPath(path);
	return engine === "heuristic" || engine === "wasm";
}

function fold({ path, text, settings }: ReadFolderInput): ReadFolderResult {
	const language = languageForPath(path);
	if (!language) return { status: "unsupported", reason: "unsupported_language" };
	const engine: ReadSummaryEngine = READ_FOLDER_SELECTION.languages[language];
	switch (engine) {
		case "unsupported":
			return { status: "unsupported", reason: "unsupported_language" };
		case "prose_exempt":
			return { status: "unsupported", reason: "prose_exempt" };
		case "raw": // Retain the pure candidate for safety/quality measurement, never default-read eligibility.
		case "heuristic":
		case "wasm": // The heuristic scan is the tree-sitter engine's fallback, so it stays callable here.
			break;
		default:
			return engine satisfies never;
	}
	// Narrow the language independently: the manifest is the sole enablement authority.
	if (language !== "ts" && language !== "js" && language !== "json")
		return { status: "unsupported", reason: "unsupported_language" };
	if (language === "json") {
		try {
			JSON.parse(text);
		} catch (error) {
			if (error instanceof SyntaxError) return { status: "parse_failure", reason: "invalid_json" };
			throw error;
		}
	}
	return composeFoldResult(text, scanBraces(text, language, settings));
}

export const selectedReadFolder: ReadFolder = Object.freeze({ id: "measured-brace", version: "3", fold });
