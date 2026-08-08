export class ToolCallProvenance {
	private readonly sessions = new Map<string, Map<string, boolean>>();

	capture(sessionId: string, toolCallId: string, trustedBuiltIn: boolean): boolean {
		let calls = this.sessions.get(sessionId);
		if (!calls) {
			calls = new Map();
			this.sessions.set(sessionId, calls);
		}
		calls.set(toolCallId, trustedBuiltIn);
		return trustedBuiltIn;
	}

	get(sessionId: string, toolCallId: string): boolean {
		return this.sessions.get(sessionId)?.get(toolCallId) ?? false;
	}
}
