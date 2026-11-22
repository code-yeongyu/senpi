import type { AgentToolResult } from "@code-yeongyu/senpi";

export function marshalToolResult(result: AgentToolResult<unknown>) {
	const texts = result.content.filter((part) => part.type === "text").map((part) => part.text);
	const images = result.content
		.filter((part) => part.type === "image")
		.map((part) => ({ mimeType: part.mimeType, dataBase64: part.data }));
	const details =
		typeof result.details === "object" &&
		result.details !== null &&
		!Array.isArray(result.details) &&
		Object.keys(result.details).length === 0
			? undefined
			: result.details;
	const hasError = toolResultIsError(result);
	const text = texts.join("\n");
	return images.length === 0 && details === undefined && !hasError ? { text } : { text, details, images, hasError };
}

/**
 * Whether a nested tool call failed: the result's own `isError` (the documented way to fail without throwing,
 * senpi#6904), or `details.isError` from tools that still report it there.
 */
export function toolResultIsError(result: AgentToolResult<unknown>): boolean {
	if (result.isError === true) return true;
	const details = result.details;
	return typeof details === "object" && details !== null && "isError" in details && details.isError === true;
}
