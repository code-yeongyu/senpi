// Synthetic transcript, event and hook-trace builders shared by the SC-LIVE checker tests.
export const assistant = (id, calls, extra = {}) => ({
	type: "message",
	id,
	message: {
		role: "assistant",
		content: calls.map(([callId, name]) => ({ type: "toolCall", id: callId, name, arguments: {} })),
		stopReason: "toolUse",
		...extra,
	},
});
export const result = (id, toolCallId, isError = false) => ({
	type: "message",
	id,
	message: { role: "toolResult", toolCallId, isError },
});
export const hooks = (...ids) =>
	ids.flatMap((toolCallId) => [
		{ event: "PreToolUse", toolCallId, session_id: "s1" },
		{ event: "PostToolUse", toolCallId, session_id: "s1" },
	]);
export const started = (...ids) =>
	ids.flatMap((toolCallId) => [
		{ type: "tool_execution_start", toolCallId },
		{ type: "tool_execution_end", toolCallId },
	]);
