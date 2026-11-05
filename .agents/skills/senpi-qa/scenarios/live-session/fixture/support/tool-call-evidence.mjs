// Independent engine evidence for every session, including eval dispatches that have no assistant toolCall block.
// Loaded from the sandbox's global extension directory so sub-agents inherit it too.
export default function toolCallEvidence(pi) {
	pi.on("tool_call", (event) => {
		pi.appendEntry("live-tool-call", { id: event.toolCallId, name: event.toolName });
	});
}
