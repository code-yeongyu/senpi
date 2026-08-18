export type CursorCliSystemInitEvent = {
	type: "system";
	subtype: "init";
	session_id: string;
	model: string;
	apiKeySource: string;
	permissionMode: string;
	cwd: string;
};

export type CursorCliThinkingEvent = {
	type: "thinking";
	subtype: "delta" | "completed";
	text: string;
};

export type CursorCliAssistantEvent = {
	type: "assistant";
	message: {
		content: Array<{ type: "text"; text: string }>;
	};
};

export type CursorCliToolSuccess = {
	success: {
		exitCode: number;
		stdout: string;
		stderr: string;
		executionTime: number;
	};
};

export type CursorCliToolRejection = {
	rejected: {
		command: string;
		reason: string;
		isReadonly: boolean;
	};
};

export type CursorCliToolResult = CursorCliToolSuccess | CursorCliToolRejection;

export type CursorCliToolCallDetails = {
	args?: Record<string, unknown>;
	result?: CursorCliToolResult;
};

export type CursorCliToolCallEvent = {
	type: "tool_call";
	subtype: "started" | "completed";
	call_id: string;
	tool_call: Partial<Record<`${string}ToolCall`, CursorCliToolCallDetails>>;
};

export type CursorCliUsage = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
};

export type CursorCliResultEvent = {
	type: "result";
	subtype: "success" | "error";
	result: unknown;
	usage: CursorCliUsage;
	request_id: string;
	duration_ms: number;
	is_error: boolean;
};

export type CursorCliMalformedStreamReason =
	| "invalid_json"
	| "invalid_event"
	| "line_overflow"
	| "truncated_tail"
	| "incomplete_stream";

export type CursorCliMalformedStreamEvent = {
	type: "malformed_stream";
	kind: "malformed_stream";
	reason: CursorCliMalformedStreamReason;
	message: string;
};

export type CursorCliStreamEvent =
	| CursorCliSystemInitEvent
	| CursorCliThinkingEvent
	| CursorCliAssistantEvent
	| CursorCliToolCallEvent
	| CursorCliResultEvent
	| CursorCliMalformedStreamEvent;

export type CursorCliStreamParserOptions = {
	maxPendingBytes?: number;
	maxDiagnostics?: number;
	maxDiagnosticCharacters?: number;
};

const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;
const DEFAULT_MAX_DIAGNOSTICS = 20;
const DEFAULT_MAX_DIAGNOSTIC_CHARACTERS = 2048;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) || value < 1 ? fallback : Math.floor(value);
}

function malformed(reason: CursorCliMalformedStreamReason, message: string): CursorCliMalformedStreamEvent {
	return { type: "malformed_stream", kind: "malformed_stream", reason, message };
}

function parseSystem(value: Record<string, unknown>): CursorCliSystemInitEvent | undefined {
	if (value.subtype !== "init") return undefined;
	const sessionId = stringValue(value.session_id);
	const model = stringValue(value.model);
	const apiKeySource = stringValue(value.apiKeySource);
	const permissionMode = stringValue(value.permissionMode);
	const cwd = stringValue(value.cwd);
	if (
		sessionId === undefined ||
		model === undefined ||
		apiKeySource === undefined ||
		permissionMode === undefined ||
		cwd === undefined
	) {
		return undefined;
	}
	return { type: "system", subtype: "init", session_id: sessionId, model, apiKeySource, permissionMode, cwd };
}

function parseThinking(value: Record<string, unknown>): CursorCliThinkingEvent | undefined {
	if (value.subtype !== "delta" && value.subtype !== "completed") return undefined;
	const text = value.text === undefined ? "" : stringValue(value.text);
	return text === undefined ? undefined : { type: "thinking", subtype: value.subtype, text };
}

function parseAssistant(value: Record<string, unknown>): CursorCliAssistantEvent | undefined {
	const message = record(value.message);
	if (!message || !Array.isArray(message.content)) return undefined;
	const content: Array<{ type: "text"; text: string }> = [];
	for (const item of message.content) {
		const block = record(item);
		if (block?.type !== "text" || typeof block.text !== "string") return undefined;
		content.push({ type: "text", text: block.text });
	}
	return { type: "assistant", message: { content } };
}

function parseToolResult(value: unknown): CursorCliToolResult | undefined {
	const result = record(value);
	const success = record(result?.success);
	if (success) {
		const exitCode = numberValue(success.exitCode);
		const stdout = stringValue(success.stdout);
		const stderr = stringValue(success.stderr);
		const executionTime = numberValue(success.executionTime);
		if (exitCode !== undefined && stdout !== undefined && stderr !== undefined && executionTime !== undefined) {
			return { success: { exitCode, stdout, stderr, executionTime } };
		}
	}
	const rejected = record(result?.rejected);
	if (rejected) {
		const command = stringValue(rejected.command);
		const reason = stringValue(rejected.reason);
		const isReadonly = booleanValue(rejected.isReadonly);
		if (command !== undefined && reason !== undefined && isReadonly !== undefined) {
			return { rejected: { command, reason, isReadonly } };
		}
	}
	return undefined;
}

function parseToolCall(value: Record<string, unknown>): CursorCliToolCallEvent | undefined {
	if (value.subtype !== "started" && value.subtype !== "completed") return undefined;
	const callId = stringValue(value.call_id);
	const source = record(value.tool_call);
	if (callId === undefined || !source) return undefined;
	const entry = Object.entries(source).find(([key, details]) => key.endsWith("ToolCall") && record(details));
	if (!entry) return undefined;
	const [kind, rawDetails] = entry;
	const details = record(rawDetails);
	if (!details) return undefined;
	const args = record(details.args);
	const result = parseToolResult(details.result);
	const normalized: CursorCliToolCallDetails = {
		...(args ? { args } : {}),
		...(result ? { result } : {}),
	};
	return {
		type: "tool_call",
		subtype: value.subtype,
		call_id: callId,
		tool_call: { [kind]: normalized },
	};
}

function parseUsage(value: unknown): CursorCliUsage | undefined {
	const usage = record(value);
	if (!usage) return undefined;
	const inputTokens = numberValue(usage.inputTokens);
	const outputTokens = numberValue(usage.outputTokens);
	const cacheReadTokens = numberValue(usage.cacheReadTokens);
	const cacheWriteTokens = numberValue(usage.cacheWriteTokens);
	if (
		inputTokens === undefined ||
		outputTokens === undefined ||
		cacheReadTokens === undefined ||
		cacheWriteTokens === undefined
	) {
		return undefined;
	}
	return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function parseResult(value: Record<string, unknown>): CursorCliResultEvent | undefined {
	if (value.subtype !== "success" && value.subtype !== "error") return undefined;
	const usage = parseUsage(value.usage);
	const requestId = stringValue(value.request_id);
	const durationMs = numberValue(value.duration_ms);
	const isError = booleanValue(value.is_error);
	if (usage === undefined || requestId === undefined || durationMs === undefined || isError === undefined) {
		return undefined;
	}
	return {
		type: "result",
		subtype: value.subtype,
		result: value.result,
		usage,
		request_id: requestId,
		duration_ms: durationMs,
		is_error: isError,
	};
}

/** Incrementally parses cursor-agent's stream-json NDJSON stdout dialect. */
export class CursorCliStreamParser {
	readonly maxPendingBytes: number;
	readonly maxDiagnostics: number;
	readonly maxDiagnosticCharacters: number;
	private decoder = new TextDecoder("utf-8", { fatal: false });
	private readonly byteCounter = new TextEncoder();
	private pending = "";
	private pendingBytes = 0;
	private discardingOverflowLine = false;
	private finalized = false;
	private sawResult = false;
	private diagnosticsRing: string[] = [];
	private unknownCount = 0;

	constructor(options: CursorCliStreamParserOptions = {}) {
		this.maxPendingBytes = positiveInteger(options.maxPendingBytes, DEFAULT_MAX_PENDING_BYTES);
		this.maxDiagnostics = positiveInteger(options.maxDiagnostics, DEFAULT_MAX_DIAGNOSTICS);
		this.maxDiagnosticCharacters = positiveInteger(
			options.maxDiagnosticCharacters,
			DEFAULT_MAX_DIAGNOSTIC_CHARACTERS,
		);
	}

	get diagnostics(): readonly string[] {
		return this.diagnosticsRing;
	}

	get unknownEventCount(): number {
		return this.unknownCount;
	}

	push(chunk: Uint8Array): CursorCliStreamEvent[] {
		if (this.finalized) this.reset();
		try {
			return this.consumeDecoded(this.decoder.decode(chunk, { stream: true }));
		} catch (error: unknown) {
			return [malformed("invalid_event", error instanceof Error ? error.message : "Unable to decode stream chunk")];
		}
	}

	finish(): CursorCliStreamEvent[] {
		if (this.finalized) return [];
		const events: CursorCliStreamEvent[] = [];
		try {
			events.push(...this.consumeDecoded(this.decoder.decode()));
			if (this.discardingOverflowLine) {
				this.discardingOverflowLine = false;
			} else if (this.pending.length > 0) {
				const tail = this.pending;
				this.clearPending();
				events.push(...this.parseLine(tail, true));
			}
		} catch (error: unknown) {
			events.push(
				malformed("truncated_tail", error instanceof Error ? error.message : "Unable to finalize stream tail"),
			);
		}
		if (!this.sawResult) {
			events.push(malformed("incomplete_stream", "cursor-agent stream ended without a result event"));
		}
		this.finalized = true;
		return events;
	}

	reset(): void {
		this.decoder = new TextDecoder("utf-8", { fatal: false });
		this.clearPending();
		this.discardingOverflowLine = false;
		this.finalized = false;
		this.sawResult = false;
		this.diagnosticsRing = [];
		this.unknownCount = 0;
	}

	private consumeDecoded(decoded: string): CursorCliStreamEvent[] {
		const events: CursorCliStreamEvent[] = [];
		let start = 0;
		while (start < decoded.length) {
			const newline = decoded.indexOf("\n", start);
			if (newline === -1) {
				this.appendPending(decoded.slice(start), events);
				break;
			}
			this.appendPending(decoded.slice(start, newline), events);
			if (this.discardingOverflowLine) {
				this.discardingOverflowLine = false;
			} else {
				const line = this.pending.endsWith("\r") ? this.pending.slice(0, -1) : this.pending;
				this.clearPending();
				events.push(...this.parseLine(line, false));
			}
			start = newline + 1;
		}
		return events;
	}

	private appendPending(fragment: string, events: CursorCliStreamEvent[]): void {
		if (fragment.length === 0 || this.discardingOverflowLine) return;
		const fragmentBytes = this.byteCounter.encode(fragment).byteLength;
		if (this.pendingBytes + fragmentBytes > this.maxPendingBytes) {
			this.recordDiagnostic(`${this.pending}${fragment}`);
			this.clearPending();
			this.discardingOverflowLine = true;
			events.push(malformed("line_overflow", `stream line exceeded ${this.maxPendingBytes} bytes`));
			return;
		}
		this.pending += fragment;
		this.pendingBytes += fragmentBytes;
	}

	private parseLine(line: string, tail: boolean): CursorCliStreamEvent[] {
		if (line.trim().length === 0) return [];
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.recordDiagnostic(line);
			return [
				malformed(tail ? "truncated_tail" : "invalid_json", tail ? "truncated JSON tail" : "non-JSON stream line"),
			];
		}
		const value = record(parsed);
		if (!value || typeof value.type !== "string") {
			return [malformed("invalid_event", "stream line is not an event object")];
		}
		let event: CursorCliStreamEvent | undefined;
		switch (value.type) {
			case "system":
				event = parseSystem(value);
				break;
			case "thinking":
				event = parseThinking(value);
				break;
			case "assistant":
				event = parseAssistant(value);
				break;
			case "tool_call":
				event = parseToolCall(value);
				break;
			case "result":
				event = parseResult(value);
				if (event) this.sawResult = true;
				break;
			case "user":
				return [];
			default:
				this.unknownCount++;
				return [];
		}
		return event ? [event] : [malformed("invalid_event", `invalid ${value.type} event`)];
	}

	private recordDiagnostic(line: string): void {
		this.diagnosticsRing.push(line.slice(0, this.maxDiagnosticCharacters));
		if (this.diagnosticsRing.length > this.maxDiagnostics) this.diagnosticsRing.shift();
	}

	private clearPending(): void {
		this.pending = "";
		this.pendingBytes = 0;
	}
}
