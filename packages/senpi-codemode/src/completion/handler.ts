import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { injectSchemaInstruction } from "../bridges/schema-injection.ts";

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

type CompletionDetails = {
	readonly model: string;
	readonly structured: boolean;
};

type CompletionTier = "smol" | "default" | "slow";

class CompletionUnknownTierError extends Error {
	readonly name = "CompletionUnknownTierError";

	constructor(tier: string) {
		super(`completion() could not resolve the "${tier}" model tier; expected "smol", "default", or "slow".`);
	}
}

class CompletionTierUnavailableError extends Error {
	readonly name = "CompletionTierUnavailableError";

	constructor(tier: Exclude<CompletionTier, "default">) {
		super(`completion() could not resolve the "${tier}" model tier: no configured models are available.`);
	}
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
	const tier = resolveCompletionTier(request.model);
	const model = resolveRequestedModel(ctx, tier);
	if (!model) throw unavailableModelError(tier);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw noModelCredentialsError(auth.error);
	if (!auth.apiKey) throw noModelCredentialsError();
	const requestModel = auth.upstreamModelId ? { ...model, id: auth.upstreamModelId } : model;
	const structured = request.schema !== undefined;
	const prompt = structured ? injectSchemaInstruction(request.prompt, request.schema) : request.prompt;
	const message = await complete(
		requestModel,
		{
			systemPrompt: request.system ?? "You are a helpful assistant.",
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			extraBody: auth.extraBody,
			signal: ctx.signal,
		},
	);
	return formatCompletion(message, model, structured);
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

function resolveCompletionTier(requested: string | undefined): CompletionTier {
	switch (requested) {
		case undefined:
		case "default":
			return "default";
		case "smol":
			return "smol";
		case "slow":
			return "slow";
		default:
			throw new CompletionUnknownTierError(requested);
	}
}

function resolveRequestedModel(ctx: ExtensionContext, tier: CompletionTier): Model<Api> | undefined {
	switch (tier) {
		case "default":
			return ctx.model;
		case "smol":
			return lowestCostModel(ctx.modelRegistry.getAvailable());
		case "slow":
			return highestCostModel(ctx.modelRegistry.getAvailable());
		default:
			return assertNever(tier);
	}
}

function unavailableModelError(tier: CompletionTier): Error {
	switch (tier) {
		case "default":
			return noModelCredentialsError();
		case "smol":
		case "slow":
			return new CompletionTierUnavailableError(tier);
		default:
			return assertNever(tier);
	}
}

function lowestCostModel(models: readonly Model<Api>[]): Model<Api> | undefined {
	let selected: Model<Api> | undefined;
	for (const model of models) {
		if (selected === undefined || promptAndResponseCost(model) < promptAndResponseCost(selected)) selected = model;
	}
	return selected;
}

function highestCostModel(models: readonly Model<Api>[]): Model<Api> | undefined {
	let selected: Model<Api> | undefined;
	for (const model of models) {
		if (selected === undefined || promptAndResponseCost(model) > promptAndResponseCost(selected)) selected = model;
	}
	return selected;
}

function promptAndResponseCost(model: Model<Api>): number {
	return model.cost.input + model.cost.output;
}

function formatCompletion(message: AssistantMessage, model: Model<Api>, structured: boolean): CompletionResult {
	if (message.stopReason === "error") throw new Error(message.errorMessage ?? "completion() request failed.");
	if (message.stopReason === "aborted") throw new Error("completion() request aborted.");
	const text = extractText(message);
	const details = { model: formatModel(model), structured };
	if (!structured) return { text, details };
	try {
		const value: unknown = JSON.parse(text);
		return { value, details };
	} catch (error) {
		if (error instanceof SyntaxError) return { value: { parseError: error.message }, details };
		throw error;
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

function assertNever(value: never): never {
	throw new CompletionUnknownTierError(String(value));
}
