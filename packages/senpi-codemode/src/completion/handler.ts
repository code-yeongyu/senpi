import type { ExtensionContext } from "@code-yeongyu/senpi";
import { completeSimple } from "../../../ai/src/stream.ts";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "../../../ai/src/types.ts";

export interface CompletionRequest {
	readonly prompt: string;
	readonly model?: string;
	readonly system?: string;
	readonly schema?: unknown;
	readonly opts?: unknown;
}

export type CompletionResult =
	| { readonly text: string; readonly details: CompletionDetails }
	| { readonly value: unknown; readonly details: CompletionDetails };

export type CompleteSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

interface CompletionDetails {
	readonly model: string;
	readonly structured: boolean;
}

interface ResolvedAuth {
	readonly ok: boolean;
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
	readonly env?: Record<string, string>;
	readonly extraBody?: Record<string, unknown>;
	readonly upstreamModelId?: string;
	readonly error?: string;
}

export function createCompletionHandler(
	complete: CompleteSimple = completeSimple,
): (ctx: ExtensionContext) => (request: CompletionRequest) => Promise<CompletionResult> {
	return (ctx) => async (request) => runCompletion(ctx, normalizeRequest(request), complete);
}

async function runCompletion(
	ctx: ExtensionContext,
	request: CompletionRequest,
	complete: CompleteSimple,
): Promise<CompletionResult> {
	const model = resolveRequestedModel(ctx.model, request.model);
	if (!model) throw noModelCredentialsError();
	const auth = (await ctx.modelRegistry.getApiKeyAndHeaders(model)) as ResolvedAuth;
	if (!auth.ok || !auth.apiKey) throw noModelCredentialsError(auth.error);
	const requestModel = auth.upstreamModelId ? { ...model, id: auth.upstreamModelId } : model;
	const message = await complete(
		requestModel,
		{
			systemPrompt: request.system ?? "You are a helpful assistant.",
			messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() }],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			extraBody: auth.extraBody,
			signal: ctx.signal,
		},
	);
	return formatCompletion(message, model, request.schema !== undefined);
}

function normalizeRequest(request: CompletionRequest): CompletionRequest {
	if (request.opts === undefined || !isRecord(request.opts)) return request;
	return {
		...request,
		model: typeof request.opts.model === "string" ? request.opts.model : request.model,
		system: typeof request.opts.system === "string" ? request.opts.system : request.system,
		schema: "schema" in request.opts ? request.opts.schema : request.schema,
	};
}

function resolveRequestedModel(current: Model<Api> | undefined, requested: string | undefined): Model<Api> | undefined {
	if (requested === undefined || requested === "default") return current;
	if (requested === "smol" || requested === "slow") {
		throw new Error('completion() model roles are not supported; use model: "default" or omit model.');
	}
	if (!current) return undefined;
	if (requested === current.id || requested === `${current.provider}/${current.id}`) return current;
	throw new Error(`completion() could not resolve requested model "${requested}" from the current session model.`);
}

function formatCompletion(message: AssistantMessage, model: Model<Api>, structured: boolean): CompletionResult {
	if (message.stopReason === "error") throw new Error(message.errorMessage ?? "completion() request failed.");
	if (message.stopReason === "aborted") throw new Error("completion() request aborted.");
	const text = extractText(message);
	if (!structured) return { text, details: { model: formatModel(model), structured: false } };
	try {
		return { value: JSON.parse(text) as unknown, details: { model: formatModel(model), structured: true } };
	} catch {
		throw new Error("completion() did not return a structured JSON response.");
	}
}

function extractText(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") parts.push(part.text);
	}
	const text = parts.join("\n");
	if (text.length === 0) throw new Error("completion() returned no text output.");
	return text;
}

function noModelCredentialsError(reason?: string): Error {
	return new Error(`completion() has no model/credentials${reason ? `: ${reason}` : ""}`);
}

function formatModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
