import type { SDKMessage } from "./sdk-boundary.ts";

export class ClaudeSdkRefusalError extends Error {
	readonly name = "ClaudeSdkRefusalError";
	readonly category: string | undefined;

	constructor(content: string, category?: string) {
		super(`Claude refused this request${category ? ` (${category})` : ""}: ${content}`);
		this.category = category;
	}
}

function refusalDetails(message: SDKMessage): { content: string; category?: string } | undefined {
	if (message.type === "system" && message.subtype === "model_refusal_no_fallback") {
		return {
			content: message.api_refusal_explanation ?? message.content,
			...(message.api_refusal_category ? { category: message.api_refusal_category } : {}),
		};
	}
	if (message.type !== "assistant") return undefined;
	const assistantMessage = message.message as {
		stop_reason?: string | null;
		stop_details?: { category?: string | null; explanation?: string | null } | null;
	};
	if (assistantMessage.stop_reason !== "refusal") return undefined;
	const content = assistantMessage.stop_details?.explanation ?? "The request was blocked by policy.";
	const category = assistantMessage.stop_details?.category ?? undefined;
	return { content, ...(category ? { category } : {}) };
}

export function refusalError(message: SDKMessage): ClaudeSdkRefusalError | undefined {
	const details = refusalDetails(message);
	return details ? new ClaudeSdkRefusalError(details.content, details.category) : undefined;
}

export function isClaudeSdkRefusal(error: unknown): error is ClaudeSdkRefusalError {
	return error instanceof ClaudeSdkRefusalError;
}
