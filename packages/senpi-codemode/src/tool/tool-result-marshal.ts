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

export function toolResultIsError(result: AgentToolResult<unknown>): boolean {
	const details = result.details;
	return typeof details === "object" && details !== null && "isError" in details && details.isError === true;
}
