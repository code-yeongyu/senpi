// E05 fixture: a tool_call (preflight) handler that aborts the turn when it sees the batch's last call.
export default function preflightAbort(pi) {
	pi.on("tool_call", (event, ctx) => {
		if (event.toolCallId === "call_x3") ctx.abort();
	});
}
