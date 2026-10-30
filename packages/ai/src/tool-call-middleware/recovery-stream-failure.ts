import type { AssistantMessage, AssistantMessageEventStream } from "../types.ts";
import { removeToolCalls, rewriteHint } from "./recovery-stream-terminal.ts";
import type { StreamMessageProjection } from "./stream-wrapper-shared.ts";
import type { ToolCallFormat } from "./types.ts";

export type RecoveryStreamFailure = "collision" | "invalid_content_event_order" | "invalid_native_event_order";

const failureDetails: Record<RecoveryStreamFailure, { diagnosticType: string; errorMessage: string; status: string }> =
	{
		collision: {
			diagnosticType: "text_tool_call_recovery_collision",
			errorMessage: "Tool call ID collision in provider stream",
			status: "collision",
		},
		invalid_content_event_order: {
			diagnosticType: "text_tool_call_recovery_invalid_content_event",
			errorMessage: "Invalid assistant content event order",
			status: "invalid_content_event_order",
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
	options: {
		source: AssistantMessage;
		failure: RecoveryStreamFailure;
		protocol: ToolCallFormat;
	},
): void {
	const { source, failure, protocol } = options;
	const details = failureDetails[failure];
	projection.sync(source);
	const message = projection.finalize(source, false);
	const rewrittenFrom = removeToolCalls(message);
	message.stopReason = "error";
	message.errorMessage = details.errorMessage;
	message.diagnostics = [
		...(source.diagnostics ?? []),
		{
			type: details.diagnosticType,
			timestamp: Date.now(),
			details: { protocol, status: details.status },
		},
	];
	stream.push({ type: "error", reason: "error", error: message }, rewriteHint(rewrittenFrom));
	stream.end(message);
}
