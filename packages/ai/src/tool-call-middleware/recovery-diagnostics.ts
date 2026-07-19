import type { ToolCall } from "../types.ts";
import type { StreamMessageProjection } from "./stream-wrapper-shared.ts";

export function appendRecoveryDiagnostic(projection: StreamMessageProjection, toolCall: ToolCall): void {
	projection.appendDiagnostic({
		type: "text_tool_call_recovery",
		timestamp: Date.now(),
		details: {
			protocol: "antml",
			toolName: toolCall.name,
			id: toolCall.id,
			status: toolCall.incomplete === true ? "incomplete" : "complete",
		},
	});
}
