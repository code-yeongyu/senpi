import type { AssistantMessage, Usage } from "../types.ts";
import type { AssistantMessageDiagnostic } from "../utils/diagnostics.ts";

function cloneUsage(usage: Usage): Usage {
	return { ...usage, cost: { ...usage.cost } };
}

function mergedDiagnostics(
	source: AssistantMessage,
	projected: readonly AssistantMessageDiagnostic[],
): AssistantMessageDiagnostic[] | undefined {
	const diagnostics = [...(source.diagnostics ?? []), ...projected];
	return diagnostics.length > 0 ? diagnostics : undefined;
}

export function cloneAssistantMessageMetadata(
	source: AssistantMessage,
	content: AssistantMessage["content"],
	projectedDiagnostics: readonly AssistantMessageDiagnostic[],
): AssistantMessage {
	const message: AssistantMessage = {
		...source,
		content,
		usage: cloneUsage(source.usage),
	};
	const diagnostics = mergedDiagnostics(source, projectedDiagnostics);
	if (diagnostics) message.diagnostics = diagnostics;
	else delete message.diagnostics;
	return message;
}

export function syncAssistantMessageMetadata(
	target: AssistantMessage,
	source: AssistantMessage,
	projectedDiagnostics: readonly AssistantMessageDiagnostic[],
): void {
	const content = target.content;
	const targetRecord = target as unknown as Record<string, unknown>;
	for (const key of Object.keys(targetRecord)) delete targetRecord[key];
	Object.assign(targetRecord, cloneAssistantMessageMetadata(source, content, projectedDiagnostics));
}
