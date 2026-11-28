/**
 * cmd executes its own tools; senpi does not execute them.
 */

export type CmdCliUsage = {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly [key: string]: unknown;
};

export type CmdCliTextDeltaEvent = {
	readonly type: "event";
	readonly event: { readonly type: "text_delta"; readonly delta?: string };
};

export type CmdCliResultEvent = {
	readonly type: "result";
	readonly subtype?: string;
	readonly sessionId?: string;
	readonly stopReason?: string;
	readonly usage?: CmdCliUsage;
	readonly durationMs?: number;
	readonly finalText?: string;
	readonly message?: string;
};

export type CmdCliMalformedStreamEvent = {
	readonly type: "malformed_stream";
	readonly kind?: "malformed_stream";
	readonly reason: "invalid_json" | "truncated_tail" | "invalid_event" | string;
	readonly message: string;
	readonly line?: string;
};

export type CmdCliStreamEvent = CmdCliTextDeltaEvent | CmdCliResultEvent | CmdCliMalformedStreamEvent;

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
	v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Incremental NDJSON line splitter for Command Code CLI stdout.
 * Handles ONLY: text_delta (accumulate), result (message + usage passthrough),
 * unknown event types (ignore), malformed JSON (typed error).
 */
export class CmdCliStreamParser {
	private buffer = "";
	private readonly decoder = new TextDecoder("utf-8");
	private unknownCount = 0;
	private readonly diagnosticsList: string[] = [];
	private accumulated = "";

	get accumulatedText(): string {
		return this.accumulated;
	}
	get unknownEventCount(): number {
		return this.unknownCount;
	}
	get diagnostics(): readonly string[] {
		return this.diagnosticsList;
	}

	reset(): void {
		this.buffer = "";
		this.unknownCount = 0;
		this.diagnosticsList.length = 0;
		this.accumulated = "";
	}

	push(chunk: Uint8Array | string): CmdCliStreamEvent[] {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
		const events: CmdCliStreamEvent[] = [];
		let idx: number;
		while ((idx = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (line) this.parseLine(line, events, false);
		}
		return events;
	}

	finish(): CmdCliStreamEvent[] {
		const events: CmdCliStreamEvent[] = [];
		const remaining = (this.decoder.decode() + this.buffer).trim();
		this.buffer = "";
		if (remaining) this.parseLine(remaining, events, true);
		return events;
	}

	private emitError(events: CmdCliStreamEvent[], line: string, reason: string, message: string): void {
		this.diagnosticsList.push(line);
		events.push({ type: "malformed_stream", kind: "malformed_stream", reason, message, line });
	}

	private parseLine(line: string, events: CmdCliStreamEvent[], isFinish: boolean): void {
		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(line);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.emitError(events, line, isFinish ? "truncated_tail" : "invalid_json", msg);
			return;
		}

		const parsed = asRecord(parsedJson);
		if (!parsed) {
			this.emitError(events, line, "invalid_event", "Malformed stream event: line parsed as non-object");
			return;
		}

		// 1. text_delta events: ONLY { type: "event", event: { type: "text_delta", delta?: string } }
		if (parsed.type === "event") {
			const inner = asRecord(parsed.event);
			if (inner?.type === "text_delta") {
				const delta = typeof inner.delta === "string" ? inner.delta : "";
				this.accumulated += delta;
				events.push({
					type: "event",
					event: { type: "text_delta", delta },
				});
				return;
			}
		}

		// 2. final result line: expose message + usage passthrough
		if (parsed.type === "result") {
			const text = str(parsed.finalText) ?? str(parsed.message);
			events.push({
				type: "result",
				subtype: str(parsed.subtype),
				sessionId: str(parsed.sessionId),
				stopReason: str(parsed.stopReason),
				durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : undefined,
				usage: parsed.usage as CmdCliUsage,
				finalText: text,
				message: text,
			});
			return;
		}

		// 3. unknown event types: ignore
		this.unknownCount++;
	}
}
