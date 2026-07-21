import type {
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	ThinkingLevel,
} from "@earendil-works/pi-ai/compat";
import { streamSimple } from "@earendil-works/pi-ai/compat";

export const SIDE_QUERY_INSTRUCTION = [
	"The user is asking a side question about the conversation so far, outside the main task.",
	"Answer it directly and concisely from the context above.",
	"Do not continue any task, do not modify anything, and do not treat this as new work.",
].join(" ");

export const DEFAULT_ESTABLISHMENT_TIMEOUT_MS = 30_000;

export interface SideQueryContextInput {
	systemPrompt: string;
	history: readonly Message[];
	question: string;
}

export function buildSideQueryContext(input: SideQueryContextInput): Context {
	return {
		systemPrompt: `${input.systemPrompt}\n\n${SIDE_QUERY_INSTRUCTION}`,
		messages: [...input.history, { role: "user", content: input.question, timestamp: Date.now() }],
		tools: [],
	};
}

export interface SideQueryAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	extraBody?: Record<string, unknown>;
}

export interface SideQueryDeps {
	model: Model<any>;
	auth: SideQueryAuth;
	sessionId: string;
	thinkingLevel?: ThinkingLevel;
	streamFn?: StreamFunction;
	establishmentTimeoutMs?: number;
}

export interface SideQueryCallbacks {
	onTextDelta?: (delta: string) => void;
	signal?: AbortSignal;
}

export interface SideQueryResult {
	replyText: string;
}

export async function runSideQuery(
	deps: SideQueryDeps,
	context: Context,
	callbacks: SideQueryCallbacks = {},
): Promise<SideQueryResult> {
	callbacks.signal?.throwIfAborted();
	const streamFn = deps.streamFn ?? streamSimple;
	const establishment = new AbortController();
	const signal = callbacks.signal ? AbortSignal.any([callbacks.signal, establishment.signal]) : establishment.signal;
	const timeoutMs = deps.establishmentTimeoutMs ?? DEFAULT_ESTABLISHMENT_TIMEOUT_MS;
	const timeoutError = new Error(`/btw provider did not produce an event within ${Math.round(timeoutMs / 1000)}s`);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const options: SimpleStreamOptions = {
			apiKey: deps.auth.apiKey,
			headers: deps.auth.headers,
			extraBody: deps.auth.extraBody,
			sessionId: `${deps.sessionId}:btw:${crypto.randomUUID()}`,
			reasoning: deps.thinkingLevel,
			signal,
		};
		timer = setTimeout(() => establishment.abort(timeoutError), timeoutMs);
		timer.unref?.();
		const stream = await streamFn(deps.model, context, options);
		let established = false;
		let replyText = "";
		for await (const event of stream) {
			if (!established && event.type !== "start") {
				established = true;
				clearTimeout(timer);
				timer = undefined;
			}
			if (event.type === "text_delta") {
				replyText += event.delta;
				callbacks.onTextDelta?.(event.delta);
			} else if (event.type === "done") {
				break;
			} else if (event.type === "error") {
				throw new Error(event.error.errorMessage || "Side query failed");
			}
		}
		signal.throwIfAborted();
		return { replyText };
	} catch (error) {
		if (establishment.signal.aborted && !callbacks.signal?.aborted) {
			throw timeoutError;
		}
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
	}
}
