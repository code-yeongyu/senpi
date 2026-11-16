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

const failureDiagnosticTypes: ReadonlySet<string> = new Set(
	Object.values(failureDetails).map((details) => details.diagnosticType),
);

/**
 * Whether the text tool-call recovery stream ended this message with one of its own failures. Keyed on the
 * diagnostic `terminateRecoveryStreamForFailure` attaches, never on the error text: the failure is a defect in
 * our stream recovery, so callers must not treat it as a model failure another model could fix (senpi#5723).
 */
export function isToolCallRecoveryStreamFailure(message: AssistantMessage): boolean {
	return (
		message.stopReason === "error" &&
		(message.diagnostics ?? []).some((diagnostic) => failureDiagnosticTypes.has(diagnostic.type))
	);
}

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
