import type { AssistantMessage, Model, ProviderHeaders, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { CompactionResult } from "../../../compaction/index.ts";
import type { SessionBeforeCompactEvent } from "../../types.ts";
import type { OpenAiRemoteCompactionDetails, OpenAiRemoteInputItem } from "./openai-remote-convert.ts";
import {
	isOpenAiRemoteCompactionOutputItem,
	isRecord,
	OPENAI_REMOTE_COMPACTION_SCHEMA,
	providerNativeItem,
} from "./openai-remote-convert.ts";
import type { OpenAiRemoteCompactionModel, OpenAiRemoteCompactionOrigin } from "./openai-remote-model.ts";
import type { OpenAiCompactionItem } from "./openai-remote-schema.ts";
import { runWithRemoteTimeout } from "./openai-remote-timeout.ts";

type ProviderRequestPreparation = {
	transformPayload(payload: unknown): Promise<unknown>;
};

type ResponsesStream = {
	result(): Promise<AssistantMessage>;
};

type ResponsesStreamRunner = (
	model: Model<"openai-responses">,
	context: { systemPrompt: string; messages: [] },
	options: SimpleStreamOptions,
) => ResponsesStream;

type RemoteRequest = {
	body: { input: OpenAiRemoteInputItem[] };
	inputItemCount: number;
	tokensBefore: number;
};

export type ResponsesV2CompactionResult = CompactionResult<OpenAiRemoteCompactionDetails> & {
	details: OpenAiRemoteCompactionDetails;
};

export function withRemoteCompactionV2Header(headers: ProviderHeaders): ProviderHeaders {
	const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === "x-codex-beta-features");
	const tokens = new Set(
		(key === undefined ? "" : (headers[key] ?? ""))
			.split(",")
			.map((token) => token.trim())
			.filter(Boolean),
	);
	tokens.add("remote_compaction_v2");
	const next = { ...headers };
	if (key !== undefined && key !== "x-codex-beta-features") delete next[key];
	next["x-codex-beta-features"] = [...tokens].join(",");
	return next;
}

function findCompactionOutput(message: AssistantMessage): OpenAiCompactionItem | undefined {
	for (const block of message.content) {
		if (block.type !== "providerNative") continue;
		const item = providerNativeItem(block.raw);
		if (item !== undefined && isOpenAiRemoteCompactionOutputItem(item) && item.type === "compaction") {
			return item;
		}
	}
	return undefined;
}

export function supportsOpenAiResponsesRemoteCompactionV2(model: Model<"openai-responses">): boolean {
	if (model.compat?.supportsRemoteCompactionV2 !== undefined) {
		return model.compat.supportsRemoteCompactionV2;
	}
	if (model.provider !== "openai") return false;
	try {
		return new URL(model.baseUrl || "https://api.openai.com/v1").hostname === "api.openai.com";
	} catch {
		return false;
	}
}

export function supportsOpenAiResponsesWebSocket(
	model: OpenAiRemoteCompactionModel,
): model is Model<"openai-responses"> {
	if (model.provider !== "openai" || model.api !== "openai-responses") return false;
	if (model.compat?.supportsWebSocket !== undefined) return model.compat.supportsWebSocket;
	try {
		return new URL(model.baseUrl || "https://api.openai.com/v1").hostname === "api.openai.com";
	} catch {
		return false;
	}
}

export async function runOpenAiResponsesV2Compaction(args: {
	auth: { apiKey?: string; headers?: ProviderHeaders; extraBody?: Record<string, unknown> };
	event: SessionBeforeCompactEvent;
	headers: ProviderHeaders;
	model: Model<"openai-responses">;
	origin: OpenAiRemoteCompactionOrigin;
	providerRequest?: ProviderRequestPreparation;
	request: RemoteRequest;
	sessionId: string;
	stream: ResponsesStreamRunner;
	systemPrompt: string;
}): Promise<ResponsesV2CompactionResult | undefined> {
	const stream = args.stream(
		args.model,
		{ systemPrompt: args.systemPrompt, messages: [] },
		{
			apiKey: args.auth.apiKey,
			cacheRetention: "short",
			extraBody: args.auth.extraBody,
			headers: withRemoteCompactionV2Header(args.headers),
			sessionId: args.sessionId,
			signal: args.event.signal,
			transport: "sse",
			onPayload: async (payload) => {
				if (!isRecord(payload)) {
					throw new Error("Unable to read OpenAI Responses v2 compaction payload");
				}
				const rewritten = {
					...payload,
					input: [...args.request.body.input, { type: "compaction_trigger" }],
				};
				const transformed = args.providerRequest
					? await args.providerRequest.transformPayload(rewritten)
					: rewritten;
				if (
					!isRecord(transformed) ||
					!Array.isArray(transformed.input) ||
					!transformed.input.some((item) => isRecord(item) && item.type === "compaction_trigger")
				) {
					throw new Error("Unable to build OpenAI Responses v2 compaction payload");
				}
				return transformed;
			},
		},
	);
	const assistant = await stream.result();
	if (assistant.stopReason === "error" || assistant.stopReason === "aborted") return undefined;
	const compaction = findCompactionOutput(assistant);
	if (compaction === undefined) return undefined;
	const createdAt = Math.floor(assistant.timestamp / 1000);
	const responseId = compaction.id ?? `compaction-${createdAt}`;
	return {
		summary: `OpenAI remote compaction retained 1 native item (responses-v2).`,
		firstKeptEntryId: args.event.preparation.firstKeptEntryId,
		tokensBefore: args.request.tokensBefore,
		details: {
			schema: OPENAI_REMOTE_COMPACTION_SCHEMA,
			mode: "openai-remote",
			provider: args.model.provider,
			api: "openai-responses",
			transport: "responses-v2",
			modelId: args.model.id,
			responseId,
			createdAt,
			requestInputItemCount: args.request.inputItemCount,
			retainedInputItemCount: 1,
			replacementInput: [compaction],
			origin: args.origin,
		},
	};
}

type V2CompactionEvent =
	| {
			version: 1;
			action: "remote_started";
			route: "builtin.compaction.openai_remote";
			requestId: string;
			modelId: string;
			inputItemCount: number;
			transport: "responses-v2";
	  }
	| {
			version: 1;
			action: "remote_completed";
			route: "builtin.compaction.openai_remote";
			requestId: string;
			modelId: string;
			responseId: string;
			retainedInputItemCount: number;
			transport: "responses-v2";
	  }
	| {
			version: 1;
			action: "remote_fallback";
			route: "builtin.compaction.openai_remote";
			requestId: string;
			modelId: string;
			reason: string;
			transport: "responses-v2";
	  };

export async function attemptOpenAiResponsesV2Compaction(
	args: Parameters<typeof runOpenAiResponsesV2Compaction>[0] & {
		emit?: (event: V2CompactionEvent) => void;
		requestId: string;
		timeoutMs: number;
	},
): Promise<ResponsesV2CompactionResult | undefined> {
	args.emit?.({
		version: 1,
		action: "remote_started",
		route: "builtin.compaction.openai_remote",
		requestId: args.requestId,
		modelId: args.model.id,
		inputItemCount: args.request.inputItemCount,
		transport: "responses-v2",
	});
	try {
		const result = await runWithRemoteTimeout({
			signal: args.event.signal,
			timeoutMs: args.timeoutMs,
			onTimeout: () =>
				args.emit?.({
					version: 1,
					action: "remote_fallback",
					route: "builtin.compaction.openai_remote",
					requestId: args.requestId,
					modelId: args.model.id,
					reason: "remote-compaction-timeout",
					transport: "responses-v2",
				}),
			run: (signal) => runOpenAiResponsesV2Compaction({ ...args, event: { ...args.event, signal } }),
		});
		if (!result) {
			args.emit?.({
				version: 1,
				action: "remote_fallback",
				route: "builtin.compaction.openai_remote",
				requestId: args.requestId,
				modelId: args.model.id,
				reason: "responses-v2-missing-compaction-output",
				transport: "responses-v2",
			});
			return undefined;
		}
		args.emit?.({
			version: 1,
			action: "remote_completed",
			route: "builtin.compaction.openai_remote",
			requestId: args.requestId,
			modelId: args.model.id,
			responseId: result.details.responseId,
			retainedInputItemCount: result.details.retainedInputItemCount,
			transport: "responses-v2",
		});
		return result;
	} catch (error) {
		if (args.event.signal.aborted) throw error;
		args.emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: args.requestId,
			modelId: args.model.id,
			reason: "responses-v2-error",
			transport: "responses-v2",
		});
		return undefined;
	}
}
