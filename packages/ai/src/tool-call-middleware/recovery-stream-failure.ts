import type { AssistantMessage, AssistantMessageEventStream } from "../types.ts";
import type { StreamMessageProjection } from "./stream-wrapper-shared.ts";

export type RecoveryStreamFailure = "collision" | "invalid_native_event_order";

const failureDetails: Record<RecoveryStreamFailure, { diagnosticType: string; errorMessage: string; status: string }> =
	{
		collision: {
			diagnosticType: "text_tool_call_recovery_collision",
			errorMessage: "Tool call ID collision in provider stream",
			status: "collision",
		},
		invalid_native_event_order: {
			diagnosticType: "text_tool_call_recovery_invalid_native_event",
			errorMessage: "Invalid native tool call event order",
			status: "invalid_native_event_order",
		},
	};

export function terminateRecoveryStreamForFailure(
	stream: AssistantMessageEventStream,
	projection: StreamMessageProjection,
	source: AssistantMessage,
	failure: RecoveryStreamFailure,
): void {
	const details = failureDetails[failure];
	projection.sync(source);
	const message = projection.finalize(source, false);
	message.content = message.content.filter((block) => block.type !== "toolCall");
	message.stopReason = "error";
	message.errorMessage = details.errorMessage;
	message.diagnostics = [
		...(source.diagnostics ?? []),
		{
			type: details.diagnosticType,
			timestamp: Date.now(),
			details: { protocol: "antml", status: details.status },
		},
	];
	stream.push({ type: "error", reason: "error", error: message });
	stream.end(message);
}
