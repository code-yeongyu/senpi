import { type CursorCliErrorClassification, type CursorCliErrorInput, classifyCursorCliError } from "./errors.ts";
import type { CursorCliOauthResumeMode } from "./settings.ts";
import { CursorCliAbortError, CursorCliPromptTooLargeError, MAX_CURSOR_CLI_PROMPT_BYTES } from "./transport.ts";

export const CURSOR_CLI_CONTEXT_RECAP_MAX_BYTES = 8 * 1024;
export const CURSOR_CLI_CONTEXT_RECAP_BEGIN = "===== senpi context recap =====";
export const CURSOR_CLI_CONTEXT_RECAP_END = "===== end senpi context recap =====";

export type CursorCliSessionRecord = {
	readonly accountName: string;
	readonly chatId: string;
	readonly lastModel: string;
	readonly lastUsedAt: number;
};

export type CursorCliRecapExchange = {
	readonly role: "user" | "assistant";
	readonly text: string;
};

export type CursorCliSessionTurnContext = {
	readonly senpiSessionId: string;
	readonly accountName: string;
};

export type CursorCliSessionTurnInput = {
	readonly prompt: string;
	readonly model: string | undefined;
	readonly recentExchanges?: readonly CursorCliRecapExchange[];
};

export type CursorCliSessionPolicy = {
	readonly resumeMode?: CursorCliOauthResumeMode;
	readonly contextRecapOnModelSwitch?: boolean;
	readonly maxRecapBytes?: number;
	readonly promptCeilingBytes?: number;
};

export type CursorCliTurnPlan = {
	/** Chat id passed as `--resume`, or undefined for a fresh chat. */
	readonly resumeChatId: string | undefined;
	/** Final spawn prompt: the recap block prepended unless it had to be dropped for the ceiling. */
	readonly prompt: string;
	readonly contextRecap: string | undefined;
	readonly modelSwitch: boolean;
	readonly recapDroppedForCeiling: boolean;
};

export type CursorCliSessionAttempt = {
	readonly prompt: string;
	readonly resumeChatId: string | undefined;
};

export type CursorCliSessionInitObservation = {
	readonly chatId: string;
	readonly model: string;
};

export type CursorCliSessionRestartReason = "resume_failed" | "context_overflow";

export type CursorCliSessionRestartNotice = {
	readonly type: "cursor_chat_restarted";
	readonly message: string;
	readonly previousChatId: string;
	readonly reason: CursorCliSessionRestartReason;
};

export type CursorCliSessionRunOptions<TEvent> = {
	readonly senpiSessionId: string;
	readonly accountName: string;
	readonly runAttempt: (attempt: CursorCliSessionAttempt) => AsyncIterable<TEvent> | Promise<AsyncIterable<TEvent>>;
	readonly now?: () => number;
	readonly classify?: (input: CursorCliErrorInput) => CursorCliErrorClassification;
	readonly errorFromEvent?: (event: TEvent) => CursorCliErrorInput | undefined;
	readonly initFromEvent?: (event: TEvent) => CursorCliSessionInitObservation | undefined;
	readonly isVisibleAssistantDelta?: (event: TEvent) => boolean;
} & CursorCliSessionPolicy;

export type CursorCliSessionRouterDeps = {
	readonly now?: () => number;
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function utf8Prefix(text: string, maxBytes: number): string {
	if (byteLength(text) <= maxBytes) return text;
	const bytes = Buffer.from(text, "utf8");
	let end = Math.max(0, Math.min(maxBytes, bytes.length));
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
	return bytes.subarray(0, end).toString("utf8");
}

/**
 * Builds the one-turn context recap from senpi's own last exchanges, wrapped in
 * explicit delimiters and hard-capped at `maxRecapBytes` (delimiters included).
 * The newest exchanges are kept; older ones are dropped first.
 */
export function buildCursorCliContextRecap(
	model: string | undefined,
	exchanges: readonly CursorCliRecapExchange[] | undefined,
	maxRecapBytes: number = CURSOR_CLI_CONTEXT_RECAP_MAX_BYTES,
): string | undefined {
	const usable = (exchanges ?? []).filter((exchange) => exchange.text.length > 0);
	if (usable.length === 0) return undefined;
	const header = `${CURSOR_CLI_CONTEXT_RECAP_BEGIN}\n(${
		model === undefined ? "chat restarted" : `model switched to '${model}'`
	}; recent conversation from senpi's own records follows)`;
	const overheadBytes = byteLength(header) + 1 + byteLength(CURSOR_CLI_CONTEXT_RECAP_END) + 1;
	if (overheadBytes >= maxRecapBytes) return undefined;
	const budget = maxRecapBytes - overheadBytes;
	const selected: string[] = [];
	let used = 0;
	for (let index = usable.length - 1; index >= 0; index -= 1) {
		const exchange = usable[index]!;
		const line = `${exchange.role}: ${exchange.text}`;
		const cost = byteLength(line) + (selected.length > 0 ? 1 : 0);
		if (used + cost <= budget) {
			selected.unshift(line);
			used += cost;
			continue;
		}
		if (selected.length === 0) {
			selected.unshift(utf8Prefix(line, budget));
			used = budget;
		}
		break;
	}
	if (selected.length === 0) return undefined;
	return `${header}\n${selected.join("\n")}\n${CURSOR_CLI_CONTEXT_RECAP_END}`;
}

function composePrompt(recap: string | undefined, prompt: string): string {
	return recap === undefined ? prompt : `${recap}\n\n${prompt}`;
}

function shrinkToCeiling(
	recap: string | undefined,
	rawPrompt: string,
	ceilingBytes: number,
): { prompt: string; recapDropped: boolean } {
	if (recap !== undefined) {
		const composed = composePrompt(recap, rawPrompt);
		if (byteLength(composed) <= ceilingBytes) return { prompt: composed, recapDropped: false };
		if (byteLength(rawPrompt) <= ceilingBytes) return { prompt: rawPrompt, recapDropped: true };
		throw new CursorCliPromptTooLargeError(byteLength(rawPrompt), ceilingBytes);
	}
	if (byteLength(rawPrompt) > ceilingBytes) {
		throw new CursorCliPromptTooLargeError(byteLength(rawPrompt), ceilingBytes);
	}
	return { prompt: rawPrompt, recapDropped: false };
}

function isAbort(error: unknown): boolean {
	if (error instanceof CursorCliAbortError) return true;
	const value = record(error);
	return value !== undefined && (value.type === "aborted" || value.kind === "aborted");
}

function errorInput(error: unknown): CursorCliErrorInput {
	const value = record(error);
	if (value && ("exitCode" in value || "stderr" in value || "resultEvent" in value || "thrown" in value)) {
		return error as CursorCliErrorInput;
	}
	return { thrown: error };
}

function defaultInitFromEvent<TEvent>(event: TEvent): CursorCliSessionInitObservation | undefined {
	const value = record(event);
	if (value?.type !== "system" || value.subtype !== "init") return undefined;
	const chatId = typeof value.session_id === "string" ? value.session_id : undefined;
	const model = typeof value.model === "string" ? value.model : undefined;
	if (chatId === undefined || chatId.length === 0 || model === undefined || model.length === 0) {
		return undefined;
	}
	return { chatId, model };
}

function defaultErrorFromEvent<TEvent>(event: TEvent): CursorCliErrorInput | undefined {
	const value = record(event);
	if (value?.type === "malformed_stream") return { thrown: event };
	if (value?.type === "result" && (value.is_error === true || value.subtype === "error")) {
		return { resultEvent: event };
	}
	return undefined;
}

function defaultIsVisibleAssistantDelta<TEvent>(event: TEvent): boolean {
	const value = record(event);
	if (!value) return false;
	if (value.type === "assistant") {
		const message = record(value.message);
		if (!Array.isArray(message?.content)) return false;
		return message.content.some((item) => {
			const block = record(item);
			return block?.type === "text" && typeof block.text === "string" && block.text.length > 0;
		});
	}
	return (
		(value.type === "assistant_delta" || value.type === "text_delta") &&
		typeof value.delta === "string" &&
		value.delta.length > 0
	);
}

function restartNotice(
	previousChatId: string,
	reason: CursorCliSessionRestartReason,
	contextReinjected: boolean,
): CursorCliSessionRestartNotice {
	const cause = reason === "context_overflow" ? "context overflow" : "resume failure";
	return {
		type: "cursor_chat_restarted",
		message: `Cursor chat '${previousChatId}' could not continue after a ${cause}; a fresh chat was started${
			contextReinjected ? " and senpi's recent context was re-injected" : ""
		}.`,
		previousChatId,
		reason,
	};
}

class CursorCliNoAssistantOutputError extends Error {
	constructor() {
		super("Cursor CLI attempt completed without visible assistant text");
		this.name = "CursorCliNoAssistantOutputError";
	}
}

/**
 * Sticky per-senpi-session chat routing for the Cursor CLI lane. This lane
 * spawns once per turn, so routing state is just the last observed
 * `system/init` per senpi session - no resident CLI process exists to manage.
 * The turn decision itself is pure; records change only when an init event is
 * observed, so cancelled or failed turns leave prior routing intact.
 */
export class CursorCliSessionRouter {
	private readonly records = new Map<string, CursorCliSessionRecord>();
	private readonly nowFn: () => number;

	constructor(deps: CursorCliSessionRouterDeps = {}) {
		this.nowFn = deps.now ?? Date.now;
	}

	getRecord(senpiSessionId: string): Readonly<CursorCliSessionRecord> | undefined {
		const entry = this.records.get(senpiSessionId);
		return entry === undefined ? undefined : Object.freeze({ ...entry });
	}

	clear(senpiSessionId: string): void {
		this.records.delete(senpiSessionId);
	}

	planTurn(
		context: CursorCliSessionTurnContext,
		input: CursorCliSessionTurnInput,
		policy: CursorCliSessionPolicy = {},
	): CursorCliTurnPlan {
		const ceilingBytes = policy.promptCeilingBytes ?? MAX_CURSOR_CLI_PROMPT_BYTES;
		const resumeEnabled = (policy.resumeMode ?? "auto") === "auto";
		const bound = this.records.get(context.senpiSessionId);
		// Chats live inside each account's HOME, so a record bound to another
		// account can never be resumed here.
		const resumable = bound !== undefined && bound.accountName === context.accountName && resumeEnabled;
		const resumeChatId = resumable && bound !== undefined ? bound.chatId : undefined;
		const modelSwitch = resumable && bound !== undefined && bound.lastModel !== input.model;
		const recap =
			modelSwitch && policy.contextRecapOnModelSwitch !== false
				? buildCursorCliContextRecap(input.model, input.recentExchanges, policy.maxRecapBytes)
				: undefined;
		const shrunk = shrinkToCeiling(recap, input.prompt, ceilingBytes);
		return {
			resumeChatId,
			prompt: shrunk.prompt,
			contextRecap: shrunk.recapDropped ? undefined : recap,
			modelSwitch,
			recapDroppedForCeiling: shrunk.recapDropped,
		};
	}

	/** Records the chat id and effective model reported by `system/init`. */
	observeInit(
		context: CursorCliSessionTurnContext,
		init: CursorCliSessionInitObservation,
		at: number = this.nowFn(),
	): void {
		this.records.set(context.senpiSessionId, {
			accountName: context.accountName,
			chatId: init.chatId,
			lastModel: init.model,
			lastUsedAt: at,
		});
	}

	async *runTurn<TEvent>(
		options: CursorCliSessionRunOptions<TEvent>,
		input: CursorCliSessionTurnInput,
	): AsyncGenerator<TEvent | CursorCliSessionRestartNotice> {
		const now = options.now ?? this.nowFn;
		const classify = options.classify ?? classifyCursorCliError;
		const errorFromEvent = options.errorFromEvent ?? defaultErrorFromEvent;
		const initFromEvent = options.initFromEvent ?? defaultInitFromEvent;
		const isVisibleAssistantDelta = options.isVisibleAssistantDelta ?? defaultIsVisibleAssistantDelta;
		const ceilingBytes = options.promptCeilingBytes ?? MAX_CURSOR_CLI_PROMPT_BYTES;
		const context: CursorCliSessionTurnContext = {
			senpiSessionId: options.senpiSessionId,
			accountName: options.accountName,
		};
		const plan = this.planTurn(context, input, {
			resumeMode: options.resumeMode,
			contextRecapOnModelSwitch: options.contextRecapOnModelSwitch,
			maxRecapBytes: options.maxRecapBytes,
			promptCeilingBytes: options.promptCeilingBytes,
		});

		let attempt: CursorCliSessionAttempt = { prompt: plan.prompt, resumeChatId: plan.resumeChatId };
		const previousChatId = plan.resumeChatId;
		let fellBack = false;

		while (true) {
			let visibleAssistantDeltaEmitted = false;
			try {
				const stream = await options.runAttempt(attempt);
				for await (const event of stream) {
					const failure = errorFromEvent(event);
					if (failure !== undefined) throw failure;
					const init = initFromEvent(event);
					if (init !== undefined) this.observeInit(context, init, now());
					visibleAssistantDeltaEmitted ||= isVisibleAssistantDelta(event);
					yield event;
				}
				if (!visibleAssistantDeltaEmitted) throw new CursorCliNoAssistantOutputError();
				return;
			} catch (error) {
				// Aborts and post-output failures must surface exactly as thrown;
				// account-level failures belong to the failover layer above.
				if (isAbort(error) || fellBack || previousChatId === undefined || visibleAssistantDeltaEmitted) {
					throw error;
				}
				const classification = classify(errorInput(error));
				if (classification.kind !== "context_overflow" && classification.kind !== "other") throw error;
				const reason: CursorCliSessionRestartReason =
					classification.kind === "context_overflow" ? "context_overflow" : "resume_failed";
				const recap =
					plan.contextRecap ?? buildCursorCliContextRecap(undefined, input.recentExchanges, options.maxRecapBytes);
				const shrunk = shrinkToCeiling(recap, input.prompt, ceilingBytes);
				yield restartNotice(previousChatId, reason, recap !== undefined && !shrunk.recapDropped);
				attempt = { prompt: shrunk.prompt, resumeChatId: undefined };
				fellBack = true;
			}
		}
	}
}

/** Shared router instance; one record per senpi session, in-process. */
export const cursorCliSessionRouter = new CursorCliSessionRouter();
