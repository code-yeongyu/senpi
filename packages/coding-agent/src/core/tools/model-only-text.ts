import type { TextContent } from "@earendil-works/pi-ai";

export function modelOnlyText(text: string): TextContent {
	return { type: "text", text, audience: "model" };
}

const EMPTY_OUTPUT_TEXT = "(no output)";

/**
 * Stands in for a run that printed nothing (senpi#7209): providers need a non-empty block, but it is not output,
 * so a programmatic caller drops it while model-only context and notices stay.
 */
export function emptyOutputPlaceholder(): TextContent {
	return modelOnlyText(EMPTY_OUTPUT_TEXT);
}

export function isEmptyOutputPlaceholder(part: unknown): boolean {
	return (
		isModelOnlyText(part) &&
		typeof part === "object" &&
		part !== null &&
		"text" in part &&
		part.text === EMPTY_OUTPUT_TEXT
	);
}

export function isModelOnlyText(part: unknown): boolean {
	return (
		typeof part === "object" &&
		part !== null &&
		"type" in part &&
		part.type === "text" &&
		"audience" in part &&
		part.audience === "model"
	);
}
