import type { TextContent } from "@earendil-works/pi-ai";

export function modelOnlyText(text: string): TextContent {
	return { type: "text", text, audience: "model" };
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
