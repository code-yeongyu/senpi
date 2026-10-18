/** `prompt` without a streaming behavior while a turn runs; `code` is the RPC `streaming` error code. */
export class AgentBusyError extends Error {
	readonly code = "streaming" as const;

	constructor(message: string) {
		super(message);
		this.name = "AgentBusyError";
	}
}
