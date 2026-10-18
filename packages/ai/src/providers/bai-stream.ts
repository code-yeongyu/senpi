import type { ProviderStreams, SimpleStreamOptions, StreamOptions } from "../types.ts";
import { normalizeToolParametersForOpenAICompat } from "../utils/tool-schema-compat.ts";

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Repair a function tool whose root parameters schema declares no `type`.
 *
 * B.AI rejects a union-root schema with `tools.function.parameters.type is
 * required and must be "object"`. Adding a bare `type: "object"` in front of
 * the `anyOf` would satisfy that validator and still leave the root without
 * `properties`/`required`, which describes the tool to the model as taking no
 * arguments at all; `normalizeToolParametersForOpenAICompat()` instead merges
 * the union branches into one object schema, so the parameters survive.
 */
function normalizeResponsesFunctionTool(tool: unknown): unknown {
	if (!isJsonObject(tool) || tool.type !== "function") return tool;
	if (!isJsonObject(tool.parameters) || tool.parameters.type !== undefined) return tool;
	return { ...tool, parameters: normalizeToolParametersForOpenAICompat(tool.parameters) };
}

/**
 * The OpenAI Responses tool builder forwards `tool.parameters` unchanged
 * (`api/openai-responses-shared.ts` via `getJsonSchemaToolParameters()`), so a
 * union-root tool such as `workpool` reaches B.AI unrepaired. The other two
 * B.AI wire APIs already normalize their own roots and need no transform:
 * `api/openai-completions.ts` re-runs `normalizeToolParametersForOpenAICompat()`
 * after `onPayload`, and `api/anthropic-messages.ts` builds `input_schema`
 * through `resolveRootObjectSchema()`.
 */
export function normalizeBaiResponsesPayload(payload: unknown): unknown {
	if (!isJsonObject(payload) || !Array.isArray(payload.tools)) return payload;
	const sourceTools = payload.tools;
	const tools = sourceTools.map((tool) => normalizeResponsesFunctionTool(tool));
	return tools.some((tool, index) => tool !== sourceTools[index]) ? { ...payload, tools } : payload;
}

function withBaiResponsesPayload<T extends StreamOptions | SimpleStreamOptions>(options: T | undefined): T {
	const upstreamTransform = options?.onPayload;
	return {
		...options,
		onPayload: async (payload, model, request) => {
			const transformed = await upstreamTransform?.(payload, model, request);
			return normalizeBaiResponsesPayload(transformed ?? payload);
		},
	} as T;
}

export function baiResponsesStreams(streams: ProviderStreams): ProviderStreams {
	return {
		...streams,
		stream: (model, context, options) => streams.stream(model, context, withBaiResponsesPayload(options)),
		streamSimple: (model, context, options) => streams.streamSimple(model, context, withBaiResponsesPayload(options)),
	};
}
