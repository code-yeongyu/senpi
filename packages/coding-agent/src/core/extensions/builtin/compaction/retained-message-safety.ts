import type { AgentMessage } from "@earendil-works/pi-agent-core";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function hasTextOnlyContent(content: unknown, allowString: boolean): boolean {
	if (typeof content === "string") return allowString;
	if (!Array.isArray(content)) return false;
	return content.every((block) => isRecord(block) && block.type === "text" && typeof block.text === "string");
}

function isUsage(value: unknown): boolean {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
		if (!isFiniteNumber(value[field])) return false;
	}
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		if (!isFiniteNumber(value.cost[field])) return false;
	}
	return (
		(value.cacheWrite1h === undefined || isFiniteNumber(value.cacheWrite1h)) &&
		(value.reasoning === undefined || isFiniteNumber(value.reasoning))
	);
}

function hasSafeAssistantContent(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (!isRecord(block) || typeof block.type !== "string") return false;
		switch (block.type) {
			case "text":
				if (typeof block.text !== "string" || block.textSignature !== undefined) return false;
				break;
			case "thinking":
				if (
					typeof block.thinking !== "string" ||
					(block.startedAt !== undefined && !isFiniteNumber(block.startedAt)) ||
					(block.endedAt !== undefined && !isFiniteNumber(block.endedAt)) ||
					(block.redacted !== undefined && typeof block.redacted !== "boolean") ||
					block.redacted === true ||
					block.thinkingSignature !== undefined
				) {
					return false;
				}
				break;
			case "toolCall":
				if (
					typeof block.id !== "string" ||
					typeof block.name !== "string" ||
					!isRecord(block.arguments) ||
					(block.incomplete !== undefined && block.incomplete !== true) ||
					(block.errorMessage !== undefined && typeof block.errorMessage !== "string") ||
					block.thoughtSignature !== undefined
				) {
					return false;
				}
				break;
			default:
				return false;
		}
	}
	return true;
}

function hasSafeAssistantEnvelope(message: Record<string, unknown>): boolean {
	const stopReason = message.stopReason;
	const stopDetails = message.stopDetails;
	const safeStopDetails =
		stopDetails === undefined ||
		(isRecord(stopDetails) &&
			(stopDetails.type === "sensitive" ||
				(stopDetails.type === "refusal" &&
					(stopDetails.explanation === undefined || typeof stopDetails.explanation === "string"))));
	return (
		typeof message.api === "string" &&
		typeof message.provider === "string" &&
		typeof message.model === "string" &&
		isUsage(message.usage) &&
		(stopReason === "pending" ||
			stopReason === "stop" ||
			stopReason === "length" ||
			stopReason === "toolUse" ||
			stopReason === "error" ||
			stopReason === "aborted") &&
		safeStopDetails &&
		isFiniteNumber(message.timestamp) &&
		(message.responseModel === undefined || typeof message.responseModel === "string") &&
		(message.responseId === undefined || typeof message.responseId === "string") &&
		(message.diagnostics === undefined || Array.isArray(message.diagnostics)) &&
		(message.errorMessage === undefined || typeof message.errorMessage === "string") &&
		(message.rawStopReason === undefined || typeof message.rawStopReason === "string") &&
		hasSafeAssistantContent(message.content)
	);
}

function hasSafeToolResultEnvelope(message: Record<string, unknown>): boolean {
	return (
		typeof message.toolCallId === "string" &&
		message.toolCallId.length > 0 &&
		typeof message.toolName === "string" &&
		message.toolName.length > 0 &&
		hasTextOnlyContent(message.content, false) &&
		typeof message.isError === "boolean" &&
		isFiniteNumber(message.timestamp) &&
		(message.usage === undefined || isUsage(message.usage)) &&
		(message.addedToolNames === undefined ||
			(Array.isArray(message.addedToolNames) && message.addedToolNames.every((name) => typeof name === "string")))
	);
}

/** Reject any retained message that cannot be safely replayed through normalized provider conversion. */
export function hasUnsafeRetainedContent(messages: AgentMessage[]): boolean {
	for (const value of messages as unknown[]) {
		if (!isRecord(value) || typeof value.role !== "string") return true;
		switch (value.role) {
			case "user":
				if (!isFiniteNumber(value.timestamp) || !hasTextOnlyContent(value.content, true)) return true;
				break;
			case "assistant":
				if (!hasSafeAssistantEnvelope(value)) return true;
				break;
			case "toolResult":
				if (!hasSafeToolResultEnvelope(value)) return true;
				break;
			case "custom":
				if (
					typeof value.customType !== "string" ||
					typeof value.display !== "boolean" ||
					!isFiniteNumber(value.timestamp) ||
					!hasTextOnlyContent(value.content, true)
				) {
					return true;
				}
				break;
			case "bashExecution":
				if (
					typeof value.command !== "string" ||
					typeof value.output !== "string" ||
					(value.exitCode !== undefined && !isFiniteNumber(value.exitCode)) ||
					typeof value.cancelled !== "boolean" ||
					typeof value.truncated !== "boolean" ||
					(value.fullOutputPath !== undefined && typeof value.fullOutputPath !== "string") ||
					(value.excludeFromContext !== undefined && typeof value.excludeFromContext !== "boolean") ||
					!isFiniteNumber(value.timestamp)
				) {
					return true;
				}
				break;
			case "compactionSummary":
				if (
					typeof value.summary !== "string" ||
					!isFiniteNumber(value.tokensBefore) ||
					!isFiniteNumber(value.timestamp)
				) {
					return true;
				}
				break;
			default:
				return true;
		}
	}
	return false;
}
