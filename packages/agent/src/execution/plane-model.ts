import type { AssistantMessage, Context, JsonValue, ThinkingLevel } from "@earendil-works/pi-ai";
import { type NestedRequest, type PlaneHandler, PlaneRefusedError } from "./plane.ts";

/** The plane a hand's model-backed tools (a completion, a model-backed search) use to reach a model (S31, F40). */
export const MODEL_PLANE = "model";

/**
 * One completion a hand asks the brain for. It names a model only by provider and ID; the brain resolves it against
 * its own registry and credentials, or uses the session's model when `model` is absent. Nothing a hand sends can choose
 * an endpoint, a key or a header: the codec keeps only these fields.
 */
export interface ModelPlaneRequest {
	readonly model?: { readonly provider: string; readonly id: string };
	readonly context: Context;
	readonly options?: {
		readonly maxTokens?: number;
		readonly temperature?: number;
		readonly reasoning?: ThinkingLevel;
	};
}

const REASONING: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function refuse(detail: string): never {
	throw new PlaneRefusedError(`malformed_request: ${detail}`);
}

function decodeModel(value: unknown): ModelPlaneRequest["model"] {
	if (value === undefined) return undefined;
	if (!isRecord(value) || typeof value.provider !== "string" || typeof value.id !== "string") refuse("model");
	return { provider: value.provider, id: value.id };
}

function decodeContext(value: unknown): Context {
	if (!isRecord(value) || !Array.isArray(value.messages)) refuse("context");
	if (value.systemPrompt !== undefined && typeof value.systemPrompt !== "string") refuse("systemPrompt");
	if (value.tools !== undefined && !Array.isArray(value.tools)) refuse("tools");
	return {
		...(value.systemPrompt === undefined ? {} : { systemPrompt: value.systemPrompt }),
		messages: value.messages as Context["messages"],
		...(value.tools === undefined ? {} : { tools: value.tools as NonNullable<Context["tools"]> }),
	};
}

function decodeOptions(value: unknown): ModelPlaneRequest["options"] {
	if (value === undefined) return undefined;
	if (!isRecord(value)) refuse("options");
	const { maxTokens, temperature, reasoning } = value;
	if (maxTokens !== undefined && (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens <= 0))
		refuse("maxTokens");
	if (temperature !== undefined && (typeof temperature !== "number" || !Number.isFinite(temperature)))
		refuse("temperature");
	if (reasoning !== undefined && !REASONING.includes(reasoning as ThinkingLevel)) refuse("reasoning");
	return {
		...(maxTokens === undefined ? {} : { maxTokens: maxTokens as number }),
		...(temperature === undefined ? {} : { temperature: temperature as number }),
		...(reasoning === undefined ? {} : { reasoning: reasoning as ThinkingLevel }),
	};
}

/** Parses a request body, keeping only the fields of {@link ModelPlaneRequest}; refuses a malformed one. */
export function decodeModelPlaneRequest(body: unknown): ModelPlaneRequest {
	if (!isRecord(body)) refuse("body");
	const model = decodeModel(body.model);
	const options = decodeOptions(body.options);
	return {
		...(model === undefined ? {} : { model }),
		context: decodeContext(body.context),
		...(options === undefined ? {} : { options }),
	};
}

/**
 * The brain's model plane: `complete` runs one request with the brain's own model registry and credentials (fused and
 * headless: this machine's, as today; a hosted brain's credential source is card C6) and is aborted with the request.
 */
export function serveModelPlane(
	complete: (request: ModelPlaneRequest, signal: AbortSignal) => Promise<AssistantMessage>,
): PlaneHandler {
	return async (body, signal) => {
		const message = await complete(decodeModelPlaneRequest(body), signal);
		return JSON.parse(JSON.stringify(message)) as JsonValue;
	};
}

/** A hand's client for the model plane, over the running call's nested requests. */
export function createModelPlaneClient(nested: NestedRequest) {
	return {
		async complete(request: ModelPlaneRequest, signal?: AbortSignal): Promise<AssistantMessage> {
			const reply = await nested(MODEL_PLANE, JSON.parse(JSON.stringify(request)) as JsonValue, signal);
			if (!isRecord(reply) || reply.role !== "assistant" || !Array.isArray(reply.content))
				throw new PlaneRefusedError("malformed_reply");
			return reply as unknown as AssistantMessage;
		},
	};
}
