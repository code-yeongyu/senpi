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

function isWellFormedImageBlock(block: Record<string, unknown>): boolean {
	return (
		block.type === "image" &&
		typeof block.mimeType === "string" &&
		block.mimeType.startsWith("image/") &&
		typeof block.data === "string" &&
		block.data.length > 0
	);
}

function hasSafeToolResultContent(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.every(
		(block) =>
			isRecord(block) &&
			((block.type === "text" && typeof block.text === "string") || isWellFormedImageBlock(block)),
	);
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

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

/** Validate an opaque provider signature without exposing or logging content. */
function isValidOpaqueSignature(sig: unknown): sig is string {
	return typeof sig === "string" && sig.length > 0 && sig.length <= 65_536;
}

/** Gemini signatures are base64; other providers use bounded opaque strings. */
function isValidProviderSignature(sig: unknown, providerIsGoogle: boolean): sig is string {
	if (!isValidOpaqueSignature(sig)) return false;
	return !providerIsGoogle || (sig.length % 4 === 0 && base64SignaturePattern.test(sig));
}

function hasSafeAssistantContent(content: unknown, providerIsGoogle: boolean): boolean {
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (!isRecord(block) || typeof block.type !== "string") return false;
		switch (block.type) {
			case "text":
				if (typeof block.text !== "string") return false;
				if (block.textSignature !== undefined && !isValidProviderSignature(block.textSignature, providerIsGoogle)) {
					return false;
				}
				break;
			case "thinking":
				if (
					typeof block.thinking !== "string" ||
					(block.startedAt !== undefined && !isFiniteNumber(block.startedAt)) ||
					(block.endedAt !== undefined && !isFiniteNumber(block.endedAt)) ||
					(block.redacted !== undefined && typeof block.redacted !== "boolean")
				) {
					return false;
				}
				// Redacted thinking requires a bounded opaque signature for replay.
				if (
					(block.thinkingSignature !== undefined &&
						!isValidProviderSignature(block.thinkingSignature, providerIsGoogle)) ||
					(block.redacted === true && !isValidOpaqueSignature(block.thinkingSignature))
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
					(block.errorMessage !== undefined && typeof block.errorMessage !== "string")
				) {
					return false;
				}
				if (
					block.thoughtSignature !== undefined &&
					!isValidProviderSignature(block.thoughtSignature, providerIsGoogle)
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
	const provider = typeof message.provider === "string" ? message.provider : "";
	const providerIsGoogle = provider === "google" || provider === "google-vertex";
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
		hasSafeAssistantContent(message.content, providerIsGoogle)
	);
}

function hasSafeToolResultEnvelope(message: Record<string, unknown>): boolean {
	return (
		typeof message.toolCallId === "string" &&
		message.toolCallId.length > 0 &&
		typeof message.toolName === "string" &&
		message.toolName.length > 0 &&
		hasSafeToolResultContent(message.content) &&
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
