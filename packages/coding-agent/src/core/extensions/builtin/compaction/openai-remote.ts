import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { CompactionResult } from "../../../compaction/index.ts";
import type { SessionEntry } from "../../../session-manager.ts";
import type { ServiceTier, SessionBeforeCompactEvent } from "../../types.ts";
import type {
	OpenAiCompactBody,
	OpenAiContextCompactionItem,
	OpenAiContextCompactionTriggerItem,
	OpenAiRemoteCompactionDetails,
	OpenAiRemoteInputItem,
	OpenAiRemoteTransport,
} from "./openai-remote-convert.ts";
import {
	convertBranchEntries,
	convertPendingMessages,
	getOpenAiRemoteCompactionDetails,
	isOpenAiContextCompactionItem,
	isOpenAiRemoteCompactionOutputItem,
	isRecord,
	isRetainedRemoteOutputItem,
	isRetainedResponsesStreamInputItem,
	OPENAI_REMOTE_COMPACTION_SCHEMA,
	providerNativeItem,
} from "./openai-remote-convert.ts";
import {
	createOpenAiRemoteCompactionHeaders,
	isOpenAiRemoteCompactionModel,
	matchesOpenAiRemoteCompactionIdentity,
	type OpenAiRemoteCompactionModel,
	openAiRemoteCompactionEndpointPath,
	openAiRemoteCompactionEndpointUrl,
	openAiRemoteCompactionIdentity,
} from "./openai-remote-model.ts";

export type {
	OpenAiRemoteCompactionDetails,
	OpenAiRemoteInputItem,
} from "./openai-remote-convert.ts";
export { getOpenAiRemoteCompactionDetails, OPENAI_REMOTE_COMPACTION_SCHEMA } from "./openai-remote-convert.ts";

export const SENPI_COMPACTION_EVENT = "senpi:compaction";

export type OpenAiRemoteCompactionRequest = {
	body: OpenAiCompactBody;
	inputItemCount: number;
	tokensBefore: number;
};

export type OpenAiRemoteCompactionResult = CompactionResult<OpenAiRemoteCompactionDetails> & {
	details: OpenAiRemoteCompactionDetails;
};

type OpenAiCompactedResponse = {
	id: string;
	created_at: number;
	object: "response.compaction";
	output: OpenAiRemoteInputItem[];
	usage?: Record<string, unknown>;
};

type OpenAiResponsesStream = {
	result(): Promise<AssistantMessage>;
};

type OpenAiResponsesStreamRunner = (
	model: Model<"openai-responses">,
	context: Context,
	options: SimpleStreamOptions,
) => OpenAiResponsesStream;

type OpenAiRemoteCompactionDependencies = {
	fetch?: typeof fetch;
	now?: () => number;
	remoteTimeoutMs?: number;
	streamRunner?: OpenAiResponsesStreamRunner;
};

type OpenAiRemoteCompactionContext = {
	getSystemPrompt(): string;
	model: Model<Api> | undefined;
	modelRegistry: {
		getApiKeyAndHeaders(model: Model<Api>): Promise<
			| {
					ok: true;
					apiKey?: string;
					headers?: Record<string, string>;
					extraBody?: Record<string, unknown>;
					upstreamModelId?: string;
					serviceTier?: ServiceTier;
			  }
			| {
					ok: false;
					error: string;
			  }
		>;
	};
	serviceTier: ServiceTier | undefined;
	sessionManager: {
		getSessionId(): string;
	};
};

type OpenAiRemoteCompactionEvent =
	| {
			version: 1;
			action: "remote_started";
			route: "builtin.compaction.openai_remote";
			requestId: string;
			modelId: string;
			inputItemCount: number;
			transport: OpenAiRemoteTransport;
	  }
	| {
			version: 1;
			action: "remote_completed";
			route: "builtin.compaction.openai_remote";
			requestId: string;
			modelId: string;
			responseId: string;
			retainedInputItemCount: number;
			transport: OpenAiRemoteTransport;
	  }
	| {
			version: 1;
			action: "remote_fallback";
			route: "builtin.compaction.openai_remote";
			requestId: string;
			modelId?: string;
			reason: string;
			transport?: OpenAiRemoteTransport;
	  }
	| {
			version: 1;
			action: "remote_payload_rewritten";
			route: "builtin.compaction.openai_remote";
			modelId: string;
			compactionEntryId: string;
			inputItemCount: number;
	  };

type EmitCompactionEvent = (event: OpenAiRemoteCompactionEvent) => void;

const OPENAI_REMOTE_COMPACTION_TIMEOUT_MS = 15_000;
const REMOTE_COMPACTION_TIMEOUT_REASON = "remote-compaction-timeout";

function supportsOpenAiResponsesWebSocket(model: OpenAiRemoteCompactionModel): model is Model<"openai-responses"> {
	if (model.provider !== "openai" || model.api !== "openai-responses") return false;
	if (model.compat?.supportsWebSocket !== undefined) return model.compat.supportsWebSocket;
	try {
		return new URL(model.baseUrl || "https://api.openai.com/v1").hostname === "api.openai.com";
	} catch {
		return false;
	}
}

export function createOpenAiRemoteCompactionRequest(options: {
	model: Model<Api> | undefined;
	systemPrompt: string;
	branchEntries: SessionEntry[];
	tokensBefore: number;
	promptCacheKey?: string;
	serviceTier?: ServiceTier;
}): OpenAiRemoteCompactionRequest | undefined {
	if (!isOpenAiRemoteCompactionModel(options.model)) return undefined;
	const input = convertBranchEntries(options.branchEntries, options.model);
	if (input.length === 0) return undefined;
	return {
		body: {
			model: options.model.id,
			input,
			...(options.systemPrompt ? { instructions: options.systemPrompt } : {}),
			...(options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {}),
			...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
		},
		inputItemCount: input.length,
		tokensBefore: options.tokensBefore,
	};
}

function parseOpenAiCompactedResponse(options: {
	value: unknown;
	model: OpenAiRemoteCompactionModel;
	requestId: string;
	now: () => number;
}): OpenAiCompactedResponse | undefined {
	if (!isRecord(options.value) || !Array.isArray(options.value.output)) return undefined;
	if (options.model.api === "openai-responses") {
		if (
			options.value.object !== "response.compaction" ||
			typeof options.value.id !== "string" ||
			typeof options.value.created_at !== "number"
		) {
			return undefined;
		}
	}
	return {
		id: typeof options.value.id === "string" ? options.value.id : `codex-compact:${options.requestId}`,
		created_at:
			typeof options.value.created_at === "number" ? options.value.created_at : Math.floor(options.now() / 1000),
		object: "response.compaction",
		output: options.value.output.filter((item): item is OpenAiRemoteInputItem => isRecord(item)),
		...(isRecord(options.value.usage) ? { usage: options.value.usage } : {}),
	};
}

export function buildOpenAiRemoteCompactionResult(options: {
	model: OpenAiRemoteCompactionModel;
	firstKeptEntryId: string;
	tokensBefore: number;
	requestInputItemCount: number;
	response: OpenAiCompactedResponse;
}): OpenAiRemoteCompactionResult {
	const replacementInput = options.response.output.filter(isRetainedRemoteOutputItem);
	const compactionItem = replacementInput.find(isOpenAiRemoteCompactionOutputItem);
	if (!compactionItem) {
		throw new Error("OpenAI remote compaction did not return a compaction item");
	}

	const details = {
		schema: OPENAI_REMOTE_COMPACTION_SCHEMA,
		mode: "openai-remote",
		...openAiRemoteCompactionIdentity(options.model),
		transport: "compact-endpoint",
		modelId: options.model.id,
		responseId: options.response.id,
		createdAt: options.response.created_at,
		requestInputItemCount: options.requestInputItemCount,
		retainedInputItemCount: replacementInput.length,
		replacementInput,
		...(options.response.usage ? { usage: options.response.usage } : {}),
	} satisfies OpenAiRemoteCompactionDetails;
	const endpointPath =
		options.model.api === "openai-codex-responses"
			? `/${openAiRemoteCompactionEndpointPath(options.model)}`
			: "/v1/responses/compact";

	return {
		summary: [
			"OpenAI remote compaction checkpoint.",
			`Native ${endpointPath} replay is active for ${replacementInput.length.toLocaleString()} retained item(s).`,
			`Original OpenAI input items compacted: ${options.requestInputItemCount.toLocaleString()}.`,
		].join("\n"),
		firstKeptEntryId: options.firstKeptEntryId,
		tokensBefore: options.tokensBefore,
		details,
	};
}

async function runWithRemoteTimeout<T>(options: {
	signal: AbortSignal;
	timeoutMs: number;
	run: (signal: AbortSignal) => Promise<T>;
	onTimeout: () => void;
}): Promise<T | undefined> {
	if (options.signal.aborted) {
		throw new Error("Request was aborted");
	}

	const controller = new AbortController();
	let timedOut = false;
	const abortFromSource = () => controller.abort();
	options.signal.addEventListener("abort", abortFromSource, { once: true });

	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<"timeout">((resolve) => {
		timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
			resolve("timeout");
		}, options.timeoutMs);
		const unref = timeout.unref;
		if (unref) unref.call(timeout);
	});

	const operation = options.run(controller.signal);
	try {
		const result = await Promise.race([operation, timeoutPromise]);
		if (result === "timeout") {
			options.onTimeout();
			operation.catch(() => undefined);
			return undefined;
		}
		return result;
	} catch (error) {
		if (timedOut && !options.signal.aborted) {
			options.onTimeout();
			return undefined;
		}
		throw error;
	} finally {
		if (timeout) clearTimeout(timeout);
		options.signal.removeEventListener("abort", abortFromSource);
	}
}

function createOpenAiResponsesStreamCompactionInput(request: OpenAiRemoteCompactionRequest): OpenAiRemoteInputItem[] {
	return [...request.body.input, { type: "context_compaction" } satisfies OpenAiContextCompactionTriggerItem];
}

export function createOpenAiResponsesStreamCompactionPayload(
	payload: unknown,
	request: OpenAiRemoteCompactionRequest,
): unknown | undefined {
	if (!isRecord(payload)) return undefined;
	return {
		...payload,
		model: request.body.model,
		input: [...leadingPromptMessages(payload.input), ...createOpenAiResponsesStreamCompactionInput(request)],
		...(request.body.prompt_cache_key ? { prompt_cache_key: request.body.prompt_cache_key } : {}),
		...(request.body.service_tier ? { service_tier: request.body.service_tier } : {}),
	};
}

function findResponsesStreamCompactionOutput(message: AssistantMessage): OpenAiContextCompactionItem | undefined {
	for (const block of message.content) {
		if (block.type !== "providerNative") continue;
		const item = providerNativeItem(block.raw);
		if (item && isOpenAiContextCompactionItem(item)) return item;
	}
	return undefined;
}

function usageRecordFromAssistant(message: AssistantMessage): Record<string, unknown> {
	return {
		input: message.usage.input,
		output: message.usage.output,
		cacheRead: message.usage.cacheRead,
		cacheWrite: message.usage.cacheWrite,
		totalTokens: message.usage.totalTokens,
	};
}

export function buildOpenAiResponsesStreamCompactionResult(options: {
	model: Model<"openai-responses">;
	firstKeptEntryId: string;
	tokensBefore: number;
	requestInput: OpenAiRemoteInputItem[];
	response: AssistantMessage;
	now: () => number;
}): OpenAiRemoteCompactionResult {
	const compactionItem = findResponsesStreamCompactionOutput(options.response);
	if (!compactionItem) {
		throw new Error("OpenAI Responses stream compaction did not return a context_compaction item");
	}

	const retainedInput = options.requestInput.filter(isRetainedResponsesStreamInputItem);
	const replacementInput = [...retainedInput, compactionItem];
	const details = {
		schema: OPENAI_REMOTE_COMPACTION_SCHEMA,
		mode: "openai-remote",
		provider: "openai",
		api: "openai-responses",
		transport: "websocket",
		modelId: options.model.id,
		responseId: options.response.responseId ?? `response-${options.now()}`,
		createdAt: Math.floor(options.response.timestamp / 1000),
		requestInputItemCount: options.requestInput.length,
		retainedInputItemCount: replacementInput.length,
		replacementInput,
		usage: usageRecordFromAssistant(options.response),
	} satisfies OpenAiRemoteCompactionDetails;

	return {
		summary: [
			"OpenAI remote compaction checkpoint.",
			`Native Responses WebSocket replay is active for ${replacementInput.length.toLocaleString()} retained item(s).`,
			`Original OpenAI input items compacted: ${options.requestInput.length.toLocaleString()}.`,
		].join("\n"),
		firstKeptEntryId: options.firstKeptEntryId,
		tokensBefore: options.tokensBefore,
		details,
	};
}

async function runOpenAiResponsesStreamCompaction(options: {
	model: Model<"openai-responses">;
	auth: { apiKey?: string; headers?: Record<string, string>; extraBody?: Record<string, unknown> };
	firstKeptEntryId: string;
	now: () => number;
	request: OpenAiRemoteCompactionRequest;
	signal: AbortSignal;
	streamRunner: OpenAiResponsesStreamRunner;
	systemPrompt: string;
}): Promise<OpenAiRemoteCompactionResult | undefined> {
	const stream = options.streamRunner(
		options.model,
		{ systemPrompt: options.systemPrompt, messages: [] },
		{
			apiKey: options.auth.apiKey,
			cacheRetention: "short",
			extraBody: options.auth.extraBody,
			headers: options.auth.headers,
			onPayload: (payload) => {
				const rewritten = createOpenAiResponsesStreamCompactionPayload(payload, options.request);
				if (!isRecord(rewritten) || !Array.isArray(rewritten.input)) {
					throw new Error("Unable to build OpenAI Responses stream compaction payload");
				}
				return rewritten;
			},
			sessionId: options.request.body.prompt_cache_key,
			signal: options.signal,
			transport: "websocket",
		},
	);
	const response = await stream.result();
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		return undefined;
	}
	return buildOpenAiResponsesStreamCompactionResult({
		model: options.model,
		firstKeptEntryId: options.firstKeptEntryId,
		tokensBefore: options.request.tokensBefore,
		requestInput: options.request.body.input,
		response,
		now: options.now,
	});
}

async function runOpenAiCompactEndpointCompaction(options: {
	fetchImpl: typeof fetch;
	headers: Headers;
	model: OpenAiRemoteCompactionModel;
	request: OpenAiRemoteCompactionRequest;
	requestId: string;
	signal: AbortSignal;
	firstKeptEntryId: string;
	now: () => number;
	emit?: EmitCompactionEvent;
}): Promise<OpenAiRemoteCompactionResult | undefined> {
	options.emit?.({
		version: 1,
		action: "remote_started",
		route: "builtin.compaction.openai_remote",
		requestId: options.requestId,
		modelId: options.model.id,
		inputItemCount: options.request.inputItemCount,
		transport: "compact-endpoint",
	});

	let response: Response;
	try {
		response = await options.fetchImpl(openAiRemoteCompactionEndpointUrl(options.model), {
			method: "POST",
			headers: options.headers,
			body: JSON.stringify(options.request.body),
			signal: options.signal,
		});
	} catch (error) {
		if (options.signal.aborted) throw error;
		options.emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: options.requestId,
			modelId: options.model.id,
			reason: error instanceof Error ? error.message : String(error),
			transport: "compact-endpoint",
		});
		return undefined;
	}

	if (!response.ok) {
		options.emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: options.requestId,
			modelId: options.model.id,
			reason: `HTTP ${response.status}`,
			transport: "compact-endpoint",
		});
		return undefined;
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		options.emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: options.requestId,
			modelId: options.model.id,
			reason: error instanceof Error ? error.message : String(error),
			transport: "compact-endpoint",
		});
		return undefined;
	}
	const compactedResponse = parseOpenAiCompactedResponse({
		value: payload,
		model: options.model,
		requestId: options.requestId,
		now: options.now,
	});
	if (!compactedResponse) {
		options.emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: options.requestId,
			modelId: options.model.id,
			reason: "invalid-compact-response",
			transport: "compact-endpoint",
		});
		return undefined;
	}

	let result: OpenAiRemoteCompactionResult;
	try {
		result = buildOpenAiRemoteCompactionResult({
			model: options.model,
			firstKeptEntryId: options.firstKeptEntryId,
			tokensBefore: options.request.tokensBefore,
			requestInputItemCount: options.request.inputItemCount,
			response: compactedResponse,
		});
	} catch (error) {
		options.emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: options.requestId,
			modelId: options.model.id,
			reason: error instanceof Error ? error.message : String(error),
			transport: "compact-endpoint",
		});
		return undefined;
	}
	options.emit?.({
		version: 1,
		action: "remote_completed",
		route: "builtin.compaction.openai_remote",
		requestId: options.requestId,
		modelId: options.model.id,
		responseId: compactedResponse.id,
		retainedInputItemCount: result.details.retainedInputItemCount,
		transport: "compact-endpoint",
	});
	return result;
}

export async function runOpenAiRemoteCompaction(
	ctx: OpenAiRemoteCompactionContext,
	event: SessionBeforeCompactEvent,
	emit?: EmitCompactionEvent,
	dependencies: OpenAiRemoteCompactionDependencies = {},
): Promise<OpenAiRemoteCompactionResult | undefined> {
	const model = ctx.model;
	if (!isOpenAiRemoteCompactionModel(model) || event.reason === "branch") {
		emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: event.requestId,
			modelId: model?.id,
			reason: event.reason === "branch" ? "branch-compaction" : "not-openai-responses",
		});
		return undefined;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: event.requestId,
			modelId: model.id,
			reason: auth.error,
		});
		return undefined;
	}

	const requestModel = auth.upstreamModelId ? { ...model, id: auth.upstreamModelId } : model;
	const serviceTier = ctx.serviceTier ?? auth.serviceTier;
	const request = createOpenAiRemoteCompactionRequest({
		model: requestModel,
		systemPrompt: ctx.getSystemPrompt(),
		branchEntries: event.branchEntries,
		tokensBefore: event.preparation.tokensBefore,
		promptCacheKey: ctx.sessionManager.getSessionId(),
		serviceTier,
	});
	if (!request) {
		emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: event.requestId,
			modelId: model.id,
			reason: "empty-compaction-input",
		});
		return undefined;
	}
	const remoteTimeoutMs = dependencies.remoteTimeoutMs ?? OPENAI_REMOTE_COMPACTION_TIMEOUT_MS;

	if (supportsOpenAiResponsesWebSocket(requestModel)) {
		emit?.({
			version: 1,
			action: "remote_started",
			route: "builtin.compaction.openai_remote",
			requestId: event.requestId,
			modelId: requestModel.id,
			inputItemCount: request.inputItemCount,
			transport: "websocket",
		});
		try {
			const result = await runWithRemoteTimeout({
				signal: event.signal,
				timeoutMs: remoteTimeoutMs,
				onTimeout: () =>
					emit?.({
						version: 1,
						action: "remote_fallback",
						route: "builtin.compaction.openai_remote",
						requestId: event.requestId,
						modelId: requestModel.id,
						reason: REMOTE_COMPACTION_TIMEOUT_REASON,
						transport: "websocket",
					}),
				run: (signal) =>
					runOpenAiResponsesStreamCompaction({
						model: requestModel,
						auth,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						now: dependencies.now ?? Date.now,
						request,
						signal,
						streamRunner:
							dependencies.streamRunner ??
							((streamModel, context, options) => streamSimple(streamModel, context, options)),
						systemPrompt: ctx.getSystemPrompt(),
					}),
			});
			if (result) {
				emit?.({
					version: 1,
					action: "remote_completed",
					route: "builtin.compaction.openai_remote",
					requestId: event.requestId,
					modelId: requestModel.id,
					responseId: result.details.responseId,
					retainedInputItemCount: result.details.retainedInputItemCount,
					transport: "websocket",
				});
				return result;
			}
			emit?.({
				version: 1,
				action: "remote_fallback",
				route: "builtin.compaction.openai_remote",
				requestId: event.requestId,
				modelId: requestModel.id,
				reason: "websocket-compaction-no-result",
				transport: "websocket",
			});
		} catch (error) {
			if (event.signal.aborted) throw error;
			emit?.({
				version: 1,
				action: "remote_fallback",
				route: "builtin.compaction.openai_remote",
				requestId: event.requestId,
				modelId: requestModel.id,
				reason: error instanceof Error ? error.message : String(error),
				transport: "websocket",
			});
		}
	}

	const headers = createOpenAiRemoteCompactionHeaders(requestModel, auth, request.body.prompt_cache_key);
	if (!headers) {
		emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: event.requestId,
			modelId: model.id,
			reason: "missing-openai-auth",
		});
		return undefined;
	}

	return runWithRemoteTimeout({
		signal: event.signal,
		timeoutMs: remoteTimeoutMs,
		onTimeout: () =>
			emit?.({
				version: 1,
				action: "remote_fallback",
				route: "builtin.compaction.openai_remote",
				requestId: event.requestId,
				modelId: requestModel.id,
				reason: REMOTE_COMPACTION_TIMEOUT_REASON,
				transport: "compact-endpoint",
			}),
		run: (signal) =>
			runOpenAiCompactEndpointCompaction({
				fetchImpl: dependencies.fetch ?? fetch,
				headers,
				model: requestModel,
				request,
				requestId: event.requestId,
				signal,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				now: dependencies.now ?? Date.now,
				emit,
			}),
	});
}

function latestRemoteCompaction(
	entries: SessionEntry[],
): { entryId: string; index: number; details: OpenAiRemoteCompactionDetails } | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "compaction") continue;
		const details = getOpenAiRemoteCompactionDetails(entry.details);
		if (details) return { entryId: entry.id, index, details };
		return undefined;
	}
	return undefined;
}

function leadingPromptMessages(input: unknown): OpenAiRemoteInputItem[] {
	if (!Array.isArray(input)) return [];
	const result: OpenAiRemoteInputItem[] = [];
	for (const item of input) {
		if (!isRecord(item)) break;
		const role = item.role;
		if (role !== "system" && role !== "developer") break;
		result.push(providerNativeItem(item) ?? { role, content: typeof item.content === "string" ? item.content : [] });
	}
	return result;
}

export function rewriteOpenAiPayloadWithRemoteCompaction(
	payload: unknown,
	options: { model: Model<Api> | undefined; branchEntries: SessionEntry[]; pendingMessages?: AgentMessage[] },
	emit?: EmitCompactionEvent,
): unknown | undefined {
	if (!isOpenAiRemoteCompactionModel(options.model) || !isRecord(payload)) return undefined;
	const remote = latestRemoteCompaction(options.branchEntries);
	if (!remote || !matchesOpenAiRemoteCompactionIdentity(options.model, remote.details)) return undefined;

	const postCompactionItems = convertBranchEntries(options.branchEntries.slice(remote.index + 1), options.model);
	// The in-flight prompt is not yet persisted in the branch at provider-request
	// time; append it so the replayed payload still carries the user's message.
	const pendingItems = convertPendingMessages(options.pendingMessages ?? [], options.model);

	const input = [
		...leadingPromptMessages(payload.input),
		...remote.details.replacementInput,
		...postCompactionItems,
		...pendingItems,
	];
	emit?.({
		version: 1,
		action: "remote_payload_rewritten",
		route: "builtin.compaction.openai_remote",
		modelId: options.model.id,
		compactionEntryId: remote.entryId,
		inputItemCount: input.length,
	});
	return { ...payload, input };
}
