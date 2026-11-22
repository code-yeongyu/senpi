import { type AgentToolResult, isEmptyOutputPlaceholder } from "@code-yeongyu/senpi";

export function marshalToolResult(result: AgentToolResult<unknown>) {
	// The empty-output placeholder is not output (senpi#7209). Other model-only parts stay: a read's injected
	// AGENTS.md and project rules are recorded as delivered, and the cell's text is how they reach the model.
	const texts = result.content.flatMap((part) =>
		part.type === "text" && !isEmptyOutputPlaceholder(part) ? [part.text] : [],
	);
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
