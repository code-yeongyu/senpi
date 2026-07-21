import type { AssistantMessage, Usage } from "../types.ts";
import type { AssistantMessageDiagnostic } from "../utils/diagnostics.ts";

function cloneUsage(usage: Usage): Usage {
	return { ...usage, cost: { ...usage.cost } };
}

function cloneLegacyUsage(usage: Usage): Usage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: usage.cost.total,
		},
	};
}

function cloneLegacyMessage(source: AssistantMessage, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: source.api,
		provider: source.provider,
		model: source.model,
		responseId: source.responseId,
		content,
		usage: cloneLegacyUsage(source.usage),
		stopReason: source.stopReason,
		errorMessage: source.errorMessage,
		timestamp: source.timestamp,
	};
}

export function cloneAssistantMessageMetadata(
	source: AssistantMessage,
	content: AssistantMessage["content"],
	projectedDiagnostics: readonly AssistantMessageDiagnostic[],
	preserveAll: boolean,
): AssistantMessage {
	if (!preserveAll) return cloneLegacyMessage(source, content);
	const message: AssistantMessage = { ...source, content, usage: cloneUsage(source.usage) };
	const diagnostics = [...(source.diagnostics ?? []), ...projectedDiagnostics];
	if (diagnostics.length > 0) message.diagnostics = diagnostics;
	else delete message.diagnostics;
	return message;
}

export function syncAssistantMessageMetadata(
	target: AssistantMessage,
	source: AssistantMessage,
	projectedDiagnostics: readonly AssistantMessageDiagnostic[],
	preserveAll: boolean,
): void {
	if (!preserveAll) {
		target.api = source.api;
		target.provider = source.provider;
		target.model = source.model;
		target.responseId = source.responseId;
		target.usage = cloneLegacyUsage(source.usage);
		target.stopReason = source.stopReason;
		target.errorMessage = source.errorMessage;
		target.timestamp = source.timestamp;
		return;
	}
	const content = target.content;
	const targetRecord = target as unknown as Record<string, unknown>;
	for (const key of Object.keys(targetRecord)) delete targetRecord[key];
	Object.assign(targetRecord, cloneAssistantMessageMetadata(source, content, projectedDiagnostics, true));
}
