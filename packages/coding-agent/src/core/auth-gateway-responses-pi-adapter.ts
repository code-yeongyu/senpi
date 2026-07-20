import { randomBytes } from "node:crypto";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type {
	AuthGatewayProviderRuntime,
	AuthGatewayProviderRuntimeCall,
	AuthGatewayProviderRuntimeResult,
} from "./auth-gateway-provider-runtime.ts";
import {
	appendGatewayAssistant,
	gatewayResponseBody,
	piGatewayFrames,
	responsesGatewayFrames,
	safeGatewayResult,
} from "./auth-gateway-responses-pi-events.ts";

type GatewayJson = Readonly<Record<string, unknown>>;
const MAX_CHAINED_CONTEXTS = 256;

export type AuthGatewayAdapterResult =
	| { readonly body: GatewayJson; readonly kind: "json"; readonly statusCode: number }
	| { readonly frames: AsyncIterable<unknown>; readonly kind: "stream"; readonly statusCode: 200 };

export type AuthGatewayResponsesPiAdapter = {
	pi(request: AuthGatewayResponsesPiRequest): Promise<AuthGatewayAdapterResult>;
	responses(request: AuthGatewayResponsesPiRequest): Promise<AuthGatewayAdapterResult>;
};

export type AuthGatewayResponsesPiRequest = {
	readonly body: unknown;
	readonly signal?: AbortSignal;
};

export type AuthGatewayResponsesPiAdapterOptions = {
	readonly runtime: AuthGatewayProviderRuntime;
};

type ResponsesRequest = {
	readonly input: string;
	readonly model: string;
	readonly previousResponseId: string | undefined;
	readonly sessionId: string | undefined;
	readonly stream: boolean;
};

type PiRequest = {
	readonly context: Context;
	readonly modelId: string;
	readonly sessionId: string | undefined;
	readonly stream: boolean;
};

export function createAuthGatewayResponsesPiAdapter(
	options: AuthGatewayResponsesPiAdapterOptions,
): AuthGatewayResponsesPiAdapter {
	return new ResponsesPiAdapter(options.runtime);
}

class ResponsesPiAdapter implements AuthGatewayResponsesPiAdapter {
	private readonly runtime: AuthGatewayProviderRuntime;
	private readonly chainedContexts = new Map<string, Context>();

	constructor(runtime: AuthGatewayProviderRuntime) {
		this.runtime = runtime;
	}

	async responses(input: AuthGatewayResponsesPiRequest): Promise<AuthGatewayAdapterResult> {
		const request = parseResponsesRequest(input.body);
		if (request === undefined) return invalidRequest();
		const previous =
			request.previousResponseId === undefined ? undefined : this.chainedContexts.get(request.previousResponseId);
		if (request.previousResponseId !== undefined && previous === undefined) return unknownResponse();
		const context: Context = {
			messages: [...(previous?.messages ?? []), { content: request.input, role: "user", timestamp: Date.now() }],
			...(previous?.systemPrompt === undefined ? {} : { systemPrompt: previous.systemPrompt }),
			...(previous?.tools === undefined ? {} : { tools: previous.tools }),
		};
		const result = await this.runtime.stream(runtimeCall(request.model, context, request.sessionId, input.signal));
		return this.responsesResult(result, request, context);
	}

	async pi(input: AuthGatewayResponsesPiRequest): Promise<AuthGatewayAdapterResult> {
		const request = parsePiRequest(input.body);
		if (request === undefined) return invalidRequest();
		const result = await this.runtime.stream(
			runtimeCall(request.modelId, request.context, request.sessionId, input.signal),
		);
		if (result.kind !== "stream") return runtimeFailure(result);
		if (!request.stream) {
			const message = await safeGatewayResult(result.stream);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				return {
					body: {
						error: {
							message: message.errorMessage ?? message.stopReason,
							type: message.stopReason === "aborted" ? "request_aborted" : "upstream_error",
						},
					},
					kind: "json",
					statusCode: message.stopReason === "aborted" ? 499 : 502,
				};
			}
			return { body: { message }, kind: "json", statusCode: 200 };
		}
		return { frames: piGatewayFrames(result.stream), kind: "stream", statusCode: 200 };
	}

	private async responsesResult(
		result: AuthGatewayProviderRuntimeResult,
		request: ResponsesRequest,
		context: Context,
	): Promise<AuthGatewayAdapterResult> {
		if (result.kind !== "stream") return runtimeFailure(result);
		const responseId = this.nextResponseId();
		if (!request.stream) {
			const message = await safeGatewayResult(result.stream);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				return {
					body: {
						error: {
							message: message.errorMessage ?? message.stopReason,
							type: message.stopReason === "aborted" ? "request_aborted" : "upstream_error",
						},
					},
					kind: "json",
					statusCode: message.stopReason === "aborted" ? 499 : 502,
				};
			}
			this.storeContext(responseId, appendGatewayAssistant(context, message));
			return { body: gatewayResponseBody(responseId, result.model.id, message), kind: "json", statusCode: 200 };
		}
		return {
			frames: responsesGatewayFrames(result.stream, responseId, result.model.id, (message) => {
				this.storeContext(responseId, appendGatewayAssistant(context, message));
			}),
			kind: "stream",
			statusCode: 200,
		};
	}

	private nextResponseId(): string {
		return `resp_gateway_${randomBytes(24).toString("base64url")}`;
	}

	private storeContext(responseId: string, context: Context): void {
		while (this.chainedContexts.size >= MAX_CHAINED_CONTEXTS) {
			const oldest = this.chainedContexts.keys().next().value;
			if (oldest === undefined) break;
			this.chainedContexts.delete(oldest);
		}
		this.chainedContexts.set(responseId, context);
	}
}

function runtimeCall(
	modelId: string,
	context: Context,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): AuthGatewayProviderRuntimeCall {
	const separator = modelId.indexOf("/");
	const provider = separator > 0 ? modelId.slice(0, separator) : "openai";
	const resolvedModelId = separator > 0 ? modelId.slice(separator + 1) : modelId;
	const streamOptions: Omit<SimpleStreamOptions, "apiKey" | "env" | "extraBody" | "headers" | "signal"> | undefined =
		sessionId === undefined ? undefined : { sessionId };
	return { context, modelId: resolvedModelId, provider, signal, streamOptions };
}

function parseResponsesRequest(body: unknown): ResponsesRequest | undefined {
	if (!isRecord(body) || typeof body.model !== "string" || typeof body.input !== "string") return undefined;
	if (body.stream !== undefined && typeof body.stream !== "boolean") return undefined;
	if (body.previous_response_id !== undefined && typeof body.previous_response_id !== "string") return undefined;
	if (body.prompt_cache_key !== undefined && typeof body.prompt_cache_key !== "string") return undefined;
	if (body.signal !== undefined) return undefined;
	return {
		input: body.input,
		model: body.model,
		previousResponseId: stringOrUndefined(body.previous_response_id),
		sessionId: stringOrUndefined(body.prompt_cache_key),
		stream: body.stream === true,
	};
}

function parsePiRequest(body: unknown): PiRequest | undefined {
	if (!isRecord(body) || typeof body.modelId !== "string" || !isContext(body.context)) return undefined;
	if (body.stream !== undefined && typeof body.stream !== "boolean") return undefined;
	if (body.signal !== undefined) return undefined;
	const options = isRecord(body.options) ? body.options : undefined;
	if (options?.sessionId !== undefined && typeof options.sessionId !== "string") return undefined;
	return {
		context: body.context,
		modelId: body.modelId,
		sessionId: options === undefined ? undefined : stringOrUndefined(options.sessionId),
		stream: body.stream !== false,
	};
}

function isContext(value: unknown): value is Context {
	return isRecord(value) && Array.isArray(value.messages);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function invalidRequest(): AuthGatewayAdapterResult {
	return {
		body: { error: { message: "invalid request body", type: "invalid_request_error" } },
		kind: "json",
		statusCode: 400,
	};
}

function unknownResponse(): AuthGatewayAdapterResult {
	return {
		body: { error: { message: "unknown previous response", type: "invalid_request_error" } },
		kind: "json",
		statusCode: 404,
	};
}

function runtimeFailure(
	result: Exclude<AuthGatewayProviderRuntimeResult, { readonly kind: "stream" }>,
): AuthGatewayAdapterResult {
	if (result.kind === "aborted") {
		return {
			body: { error: { message: "client closed request", type: "request_aborted" } },
			kind: "json",
			statusCode: 499,
		};
	}
	const message = result.kind === "model_not_found" ? "unknown model" : "gateway overloaded";
	return { body: { error: { message, type: "invalid_request_error" } }, kind: "json", statusCode: result.statusCode };
}
