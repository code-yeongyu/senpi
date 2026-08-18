import type {
	Context,
	Message,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	ThinkingLevel,
} from "@earendil-works/pi-ai/compat";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { estimateTokens } from "../../../compaction/index.ts";
import { convertToLlm } from "../../../messages.ts";
import { BUILTIN_CONTEXT_REDUCTION_OPTIONS, reduceContextMessages } from "../compaction/context-reduction.ts";
import { getPromptContextWindow } from "../compaction/index.ts";
import { pruneOldMessagesToBudget } from "../compaction/overflow-retry.ts";
import { repairOrphanedToolResults } from "../compaction/repair-tool-pairs.ts";

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
	promptContextWindow?: number;
}

function estimateMessagesTokens(messages: readonly Message[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function estimateSystemPromptTokens(systemPrompt: string): number {
	return estimateTokens({ role: "user", content: systemPrompt, timestamp: 0 });
}

function boundSideQueryMessages(
	messages: Message[],
	systemPrompt: string,
	promptContextWindow: number | undefined,
): Message[] {
	if (typeof promptContextWindow !== "number" || !Number.isFinite(promptContextWindow) || promptContextWindow <= 0) {
		return messages;
	}

	const messageBudget = promptContextWindow - estimateSystemPromptTokens(systemPrompt);
	const question = messages.at(-1);
	if (question === undefined || messageBudget < estimateMessagesTokens([question])) {
		throw new Error("/btw question does not fit this model's context window; shorten it or run /compact first.");
	}
	if (estimateMessagesTokens(messages) <= messageBudget) return messages;

	const reduced = convertToLlm(reduceContextMessages(messages, BUILTIN_CONTEXT_REDUCTION_OPTIONS).messages);
	const repaired = repairOrphanedToolResults(reduced);
	const pruned = convertToLlm(pruneOldMessagesToBudget(repaired, messageBudget));
	const bounded = repairOrphanedToolResults(pruned);
	if (estimateMessagesTokens(bounded) > messageBudget) {
		throw new Error("/btw context is too large for this model; run /compact first.");
	}
	return bounded;
}

export function getSideQueryPromptContextWindow(model: Pick<Model<string>, "contextWindow" | "maxTokens">): number {
	return getPromptContextWindow(model.contextWindow, model.maxTokens);
}

export function buildSideQueryContext(input: SideQueryContextInput): Context {
	const systemPrompt = `${input.systemPrompt}\n\n${SIDE_QUERY_INSTRUCTION}`;
	const messages = boundSideQueryMessages(
		[...input.history, { role: "user", content: input.question, timestamp: Date.now() }],
		systemPrompt,
		input.promptContextWindow,
	);
	return {
		systemPrompt,
		messages,
		tools: [],
	};
}

export interface SideQueryAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
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
