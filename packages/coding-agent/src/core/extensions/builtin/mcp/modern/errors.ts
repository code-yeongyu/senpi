const messages = {
	MCP_MRTR_ROUND_LIMIT: "Request stopped after 8 input rounds; start a new request to continue.",
	MCP_MRTR_INPUT_LIMIT: "Server input exceeds the client's supported limits.",
	MCP_MRTR_INVALID_INPUT: "Server returned an invalid input request or form schema.",
	MCP_MRTR_UNSUPPORTED_INPUT: "Server requested an undeclared client feature.",
	MCP_MRTR_PROCESSING_UNAVAILABLE: "Elicitation processing unavailable.",
	MCP_MRTR_INVALID_RESULT: "Server returned an unsupported or invalid result type/shape.",
	MCP_MRTR_CONTEXT_CHANGED: "Request stopped because its session or server authorization changed.",
	MCP_MRTR_CANCELLED: "Request was canceled before completion.",
	MCP_MRTR_TIMEOUT: "Request exceeded its operation deadline.",
	MCP_MRTR_TRANSPORT_FAILED: "Request could not complete; it was not automatically replayed.",
	MCP_TASK_TIMEOUT: "Task exceeded SENPI_MCP_TASK_TIMEOUT_MS; cancellation was requested.",
	MCP_TASK_FAILED: "Task failed with a JSON-RPC error.",
	MCP_TASK_CANCELLED: "Task was cancelled by the server.",
} as const;

export class McpMrtrError extends Error {
	readonly source = "local";
	readonly retriable = false;
	readonly code: keyof typeof messages;
	readonly remoteCode?: number;
	constructor(code: keyof typeof messages, remoteCode?: number, taskId?: string) {
		super(
			`${taskId === undefined ? "" : `Task ${taskId}: `}${messages[code]}${remoteCode === undefined ? "" : ` (remote code ${remoteCode})`}`,
		);
		this.code = code;
		this.remoteCode = remoteCode;
		this.name = "McpMrtrError";
	}
}
