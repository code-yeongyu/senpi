/**
 * Devin (Cognition/Codeium Cascade) agent API.
 *
 * One assistant turn is up to three RPCs, exactly as the released Devin CLI
 * performs them:
 * 1. `GetUserJwt` mints the short-lived user JWT the chat call must carry and
 *    names the account's API host, which can differ from the seeded one;
 * 2. `AssignModel` resolves a server-side router into a concrete model uid plus
 *    the JWT that authorizes it (router models only);
 * 3. `GetChatMessage` streams the turn: a single gzipped Connect frame out, a
 *    frame sequence of deltas back, closed by a JSON trailer that either
 *    carries the rejection or is empty.
 *
 * Cascade reports text, thinking and tool calls as separate delta fields on the
 * same message, so this adapter owns the block bookkeeping senpi's event
 * protocol expects.
 */

import type { AssistantMessage, Context, Model, StreamFunction, ToolCall } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import {
	AssignModelRequestSchema,
	AssignModelResponseSchema,
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
	GetUserJwtRequestSchema,
	GetUserJwtResponseSchema,
} from "./devin-agent/gen/cascade_pb.ts";
import { applyDevinResponse, createDevinStreamState, type DevinStreamState } from "./devin-agent/stream-state.ts";
import type { DevinAgentOptions } from "./devin-agent/types.ts";
import {
	buildDevinChatRequest,
	buildDevinRouterPrompt,
	DEVIN_ASSIGN_MODEL_PATH,
	DEVIN_CHAT_HEADERS,
	DEVIN_CHAT_MESSAGE_PATH,
	DEVIN_DEFAULT_BASE_URL,
	DEVIN_USER_JWT_PATH,
	type DevinModelAssignment,
	decodeDevinFrames,
	devinCliMetadata,
	encodeDevinRequestFrame,
	postDevinUnary,
	readDevinTrailerError,
} from "./devin-agent/wire.ts";

export const stream: StreamFunction<"devin-agent", DevinAgentOptions> = (
	model: Model<"devin-agent">,
	context: Context,
	options?: DevinAgentOptions,
) => {
	const events = new AssistantMessageEventStream();
	void run(model, context, events, options);
	return events;
};

export const streamSimple: StreamFunction<"devin-agent", DevinAgentOptions> = stream;

interface DevinSession {
	userJwt: string;
	/** Host the account is provisioned on; GetUserJwt may move it off the seed. */
	chatBaseUrl: string;
}

async function run(
	model: Model<"devin-agent">,
	context: Context,
	events: AssistantMessageEventStream,
	options: DevinAgentOptions | undefined,
): Promise<void> {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "devin-agent",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const state = createDevinStreamState();
	const signal = options?.signal;

	try {
		events.push({ type: "start", partial: output });
		const baseUrl = (model.baseUrl || DEVIN_DEFAULT_BASE_URL).replace(/\/+$/, "");
		const cascadeId = options?.cascadeId ?? crypto.randomUUID();
		const session = await mintUserJwt(baseUrl, options?.apiKey, signal);
		const assignment =
			model.compat?.modelRouter === true
				? await assignModel(model, context, session.chatBaseUrl, cascadeId, options?.apiKey, signal)
				: undefined;
		if (assignment) output.responseModel = assignment.modelUid;

		const request = buildDevinChatRequest({
			model,
			context,
			apiKey: options?.apiKey,
			userJwt: session.userJwt,
			cascadeId,
			...(assignment ? { assignment } : {}),
			...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
			...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
		});
		const response = await fetch(session.chatBaseUrl + DEVIN_CHAT_MESSAGE_PATH, {
			method: "POST",
			headers: DEVIN_CHAT_HEADERS,
			body: encodeDevinRequestFrame(GetChatMessageRequestSchema, request),
			signal,
		});
		await options?.onResponse?.({ status: response.status, headers: headersOf(response) }, model);

		if (!response.ok || !response.body) {
			throw new Error(`Devin request failed (HTTP ${response.status})${await detail(response)}`);
		}

		for await (const frame of decodeDevinFrames(response.body, GetChatMessageResponseSchema)) {
			if (frame.message) applyDevinResponse(frame.message, output, events, state);
			if (frame.trailer !== undefined) {
				const rejection = readDevinTrailerError(frame.trailer);
				if (rejection) throw new Error(rejection.formatted);
			}
		}

		finalizeBlocks(output, events, state);
		// Cascade can close a turn that carries a tool call without ever sending an
		// explicit stop reason. Only the default "stop" is upgraded: a server-reported
		// "length" means the turn was truncated, and a truncated tool call must not be
		// advertised as a complete one.
		if (output.stopReason === "stop" && output.content.some(isToolCall)) output.stopReason = "toolUse";
		// Cascade reports a server error or a content filter as a stop reason on an
		// otherwise well-formed stream. senpi's protocol has no "done because it
		// failed", so that turn terminates as an error event, not a done event.
		if (output.stopReason === "error") {
			output.errorMessage ??= "Devin ended the turn with a server error or a content filter";
			events.push({ type: "error", reason: "error", error: output });
			events.end();
			return;
		}
		events.push({ type: "done", reason: doneReasonOf(output.stopReason), message: output });
		events.end();
	} catch (error) {
		finalizeBlocks(output, events, state);
		const aborted = signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
		output.stopReason = aborted ? "aborted" : "error";
		output.errorMessage = aborted ? "Request was aborted" : messageOf(error);
		events.push({ type: "error", reason: output.stopReason, error: output });
		events.end();
	}
}

async function mintUserJwt(
	baseUrl: string,
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
): Promise<DevinSession> {
	const response = await postDevinUnary({
		baseUrl,
		path: DEVIN_USER_JWT_PATH,
		requestSchema: GetUserJwtRequestSchema,
		request: { metadata: devinCliMetadata(apiKey) },
		responseSchema: GetUserJwtResponseSchema,
		...(signal ? { signal } : {}),
	});
	if (!response.userJwt) throw new Error("Devin GetUserJwt returned an empty user JWT");
	const customHost = response.customApiServerUrl.trim().replace(/\/+$/, "");
	return { userJwt: response.userJwt, chatBaseUrl: customHost || baseUrl };
}

/**
 * A router uid is never a legal chat model uid, so a failed assignment fails the
 * turn instead of falling back to sending the router id to GetChatMessage.
 */
async function assignModel(
	model: Model<"devin-agent">,
	context: Context,
	baseUrl: string,
	cascadeId: string,
	apiKey: string | undefined,
	signal: AbortSignal | undefined,
): Promise<DevinModelAssignment> {
	const routerPrompt = buildDevinRouterPrompt(context.messages);
	const response = await postDevinUnary({
		baseUrl,
		path: DEVIN_ASSIGN_MODEL_PATH,
		requestSchema: AssignModelRequestSchema,
		request: {
			metadata: devinCliMetadata(apiKey),
			modelRouterUid: model.upstreamModelId ?? model.id,
			cascadeId,
			...(routerPrompt ? { chatMessagePrompt: routerPrompt } : {}),
		},
		responseSchema: AssignModelResponseSchema,
		...(signal ? { signal } : {}),
	});
	const assignment = response.assignment;
	if (!assignment?.modelUid || !assignment.assignmentJwt) {
		throw new Error("Devin AssignModel returned no model uid and assignment JWT");
	}
	return { modelUid: assignment.modelUid, assignmentJwt: assignment.assignmentJwt };
}

/** Narrows a settled stop reason to the three senpi accepts on a done event. */
function doneReasonOf(stopReason: AssistantMessage["stopReason"]): "stop" | "length" | "toolUse" {
	switch (stopReason) {
		case "length":
			return "length";
		case "toolUse":
			return "toolUse";
		default:
			return "stop";
	}
}

function headersOf(response: Response): Record<string, string> {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return headers;
}

function isToolCall(content: AssistantMessage["content"][number]): content is ToolCall {
	return content.type === "toolCall";
}

function finalizeBlocks(output: AssistantMessage, events: AssistantMessageEventStream, state: DevinStreamState): void {
	if (state.thinkingIndex !== undefined) {
		const block = output.content[state.thinkingIndex];
		if (block?.type === "thinking") {
			events.push({
				type: "thinking_end",
				contentIndex: state.thinkingIndex,
				content: block.thinking,
				partial: output,
			});
		}
		state.thinkingIndex = undefined;
	}
	if (state.textIndex !== undefined) {
		const block = output.content[state.textIndex];
		if (block?.type === "text") {
			events.push({ type: "text_end", contentIndex: state.textIndex, content: block.text, partial: output });
		}
		state.textIndex = undefined;
	}
	for (const [, entry] of state.toolCalls) {
		const block = output.content[entry.contentIndex];
		if (block?.type === "toolCall") {
			events.push({ type: "toolcall_end", contentIndex: entry.contentIndex, toolCall: block, partial: output });
		}
	}
	state.toolCalls.clear();
}

async function detail(response: Response): Promise<string> {
	try {
		const body = await response.text();
		return body ? `: ${body.slice(0, 500)}` : "";
	} catch {
		return "";
	}
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
