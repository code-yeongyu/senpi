import type { Context, Tool } from "@earendil-works/pi-ai";
import { z } from "zod";

const text = z.object({
	type: z.literal("text"),
	text: z.string(),
	audience: z.literal("model").optional(),
	textSignature: z.string().optional(),
});
const image = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() });
const thinking = z.object({
	type: z.literal("thinking"),
	thinking: z.string(),
	thinkingSignature: z.string().optional(),
	startedAt: z.number().optional(),
	endedAt: z.number().optional(),
	redacted: z.boolean().optional(),
});
export const toolCallSchema = z.object({
	type: z.literal("toolCall"),
	id: z.string(),
	name: z.string(),
	arguments: z.record(z.string(), z.json()),
	incomplete: z.literal(true).optional(),
	errorMessage: z.string().optional(),
	thoughtSignature: z.string().optional(),
	namespace: z.string().optional(),
});
const tokens = z.number().nonnegative();
const usageSchema = z.object({
	input: tokens,
	output: tokens,
	cacheRead: tokens,
	cacheWrite: tokens,
	totalTokens: tokens,
	contextUsage: z.object({ input: tokens, output: tokens }).nullable().optional(),
	cacheWrite1h: tokens.optional(),
	reasoning: tokens.optional(),
	costUnknown: z.literal(true).optional(),
	cost: z.object({ input: tokens, output: tokens, cacheRead: tokens, cacheWrite: tokens, total: tokens }),
});

/** A deliberate output allowlist: no diagnostics, account metadata, raw response or SDK failure text. */
export const assistantSchema = z.object({
	role: z.literal("assistant"),
	content: z.array(z.discriminatedUnion("type", [text, thinking, toolCallSchema])),
	api: z.string(),
	provider: z.string(),
	model: z.string(),
	usage: usageSchema,
	stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]),
	timestamp: z.number(),
	errorMessage: z.string().optional(),
});

const parameters = z.record(z.string(), z.json()).transform((value) => value as Tool["parameters"]);
const tool = z.strictObject({
	name: z.string().min(1),
	description: z.string(),
	parameters,
	freeform: z
		.strictObject({ type: z.literal("grammar"), syntax: z.literal("lark"), definition: z.string() })
		.optional(),
	constrainedSampling: z
		.union([
			z.literal(false),
			z.strictObject({ type: z.literal("json_schema"), strict: z.enum(["prefer", "require"]) }),
			z.strictObject({
				type: z.literal("grammar"),
				variants: z.strictObject({ openai_lark: z.string().optional(), openai_regex: z.string().optional() }),
			}),
		])
		.optional(),
});

// History may carry ledger metadata. Validate its model-consumed fields and retain only JSON
// metadata; it cannot become provider control options. Output uses the narrower allowlist above.
const message = z.discriminatedUnion("role", [
	z
		.object({
			role: z.literal("system"),
			content: z.union([z.string(), z.array(text)]),
			timestamp: z.number(),
			sections: z.record(z.string(), z.string().nullable()).optional(),
			toolsAdded: z.array(tool).optional(),
			toolsRemoved: z.array(z.object({ name: z.string() })).optional(),
		})
		.catchall(z.json()),
	z
		.object({
			role: z.literal("user"),
			content: z.union([z.string(), z.array(z.union([text, image]))]),
			timestamp: z.number(),
		})
		.catchall(z.json()),
	z
		.object({
			role: z.literal("configurationUpdate"),
			content: z.array(z.union([text, image])),
			effort: z.string(),
			timestamp: z.number(),
		})
		.catchall(z.json()),
	assistantSchema
		.extend({
			content: z.array(
				z.union([
					text,
					thinking,
					toolCallSchema,
					z.object({ type: z.literal("providerNative"), subtype: z.string(), raw: z.json() }),
				]),
			),
		})
		.catchall(z.json()),
	z
		.object({
			role: z.literal("toolResult"),
			toolCallId: z.string(),
			toolName: z.string(),
			content: z.array(z.union([text, image])),
			isError: z.boolean(),
			timestamp: z.number(),
			details: z.json().optional(),
			usage: usageSchema.optional(),
			addedToolNames: z.array(z.string()).optional(),
		})
		.catchall(z.json()),
]);

export const contextSchema = z
	.strictObject({
		systemPrompt: z.string().optional(),
		messages: z.array(message),
		tools: z.array(tool).optional(),
		activeToolNames: z.array(z.string()).optional(),
	})
	.transform((value) => value as Context);
