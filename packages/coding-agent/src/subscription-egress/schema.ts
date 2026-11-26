import { z } from "zod";
import { assistantSchema, contextSchema, toolCallSchema } from "./content-schema.ts";

const id = z.string().min(1);
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identity = { version: z.literal(1), threadId: id, epoch: sequence, callId: id };
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const options = z.strictObject({
	maxTokens: positive.optional(),
	reasoning: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
	thinkingBudgets: z
		.strictObject({
			minimal: positive.optional(),
			low: positive.optional(),
			medium: positive.optional(),
			high: positive.optional(),
			max: positive.optional(),
		})
		.optional(),
	toolChoice: z.enum(["auto", "none"]).optional(),
	cacheRetention: z.enum(["none", "short", "long"]).optional(),
});

export const providerCallCommandSchema = z.json().pipe(
	z.discriminatedUnion("type", [
		z.strictObject({
			...identity,
			type: z.literal("provider.call.start"),
			provider: z.literal("anthropic-subscription"),
			model: id,
			context: contextSchema,
			options,
		}),
		z.strictObject({ ...identity, type: z.literal("provider.call.cancel") }),
	]),
);

const partial = { partial: assistantSchema };
const indexed = { ...partial, contentIndex: sequence };
export const providerEventSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("start"), ...partial }),
	z.strictObject({ type: z.literal("text_start"), ...indexed }),
	z.strictObject({ type: z.literal("text_delta"), ...indexed, delta: z.string() }),
	z.strictObject({ type: z.literal("text_end"), ...indexed, content: z.string() }),
	z.strictObject({ type: z.literal("thinking_start"), ...indexed }),
	z.strictObject({ type: z.literal("thinking_delta"), ...indexed, delta: z.string() }),
	z.strictObject({ type: z.literal("thinking_end"), ...indexed, content: z.string() }),
	z.strictObject({ type: z.literal("toolcall_start"), ...indexed }),
	z.strictObject({ type: z.literal("toolcall_delta"), ...indexed, delta: z.string() }),
	z.strictObject({ type: z.literal("toolcall_end"), ...indexed, toolCall: toolCallSchema }),
]);

export const providerCallOutputSchema = z.discriminatedUnion("type", [
	z.strictObject({ ...identity, type: z.literal("provider.call.event"), seq: sequence, event: providerEventSchema }),
	z.strictObject({
		...identity,
		type: z.literal("provider.call.end"),
		seq: sequence,
		message: assistantSchema,
		billing: z.literal("subscription"),
	}),
	z.strictObject({
		...identity,
		type: z.literal("provider.call.error"),
		seq: sequence,
		code: z.enum(["auth", "rate_limited", "unavailable", "aborted", "invalid_request"]),
		retryable: z.boolean(),
		message: assistantSchema.optional(),
		billing: z.literal("subscription"),
	}),
]);

export type ProviderCallCommand = z.infer<typeof providerCallCommandSchema>;
export type ProviderCallOutput = z.infer<typeof providerCallOutputSchema>;
