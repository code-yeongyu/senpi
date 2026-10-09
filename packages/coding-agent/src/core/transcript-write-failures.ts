import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Message writes the session file refused. The first error of a run is reported once, by whoever
 * owns the run (its prompt, or the continuation that started it); the refused messages leave the
 * model context before the next prompt, so that context matches what a reload shows.
 */
export class TranscriptWriteFailures {
	private runFailure: { readonly error: unknown } | undefined;
	private reported = false;
	private readonly refused = new Set<AgentMessage>();

	startRun(): void {
		this.runFailure = undefined;
		this.reported = false;
	}

	record(message: AgentMessage, error: unknown): void {
		this.refused.add(message);
		this.runFailure ??= { error };
	}

	takeReport(): { readonly error: unknown } | undefined {
		if (this.reported || !this.runFailure) return undefined;
		this.reported = true;
		return this.runFailure;
	}

	/** `messages` without the refused ones, or `undefined` when none of them is there. */
	takeRefusedOut(messages: readonly AgentMessage[]): AgentMessage[] | undefined {
		if (this.refused.size === 0) return undefined;
		const refused = this.refused;
		const kept = messages.filter((message) => !refused.has(message));
		refused.clear();
		return kept.length === messages.length ? undefined : kept;
	}
}
