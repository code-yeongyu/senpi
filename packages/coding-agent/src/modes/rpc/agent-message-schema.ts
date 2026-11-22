import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { StopReason } from "@earendil-works/pi-ai";
import { z } from "zod";

// The hand's parse of the loop's transcript messages (senpi#5898): every role a session's transcript holds, each with the
// fields its readers rely on. Objects are loose, so a field this schema does not name reaches handlers untouched.

/** A count, size or index: a non-negative integer (a content index must name a slot, review L6). */
export const count = z.number().int().nonnegative();
/** A non-negative amount that may be fractional, such as a cost. */
export const amount = z.number().nonnegative();
export const isCount = (value: unknown): value is number => count.safeParse(value).success;
const timestamp = z.number().nonnegative();

const text = z.looseObject({ type: z.literal("text"), text: z.string() });
const image = z.looseObject({ type: z.literal("image"), data: z.string(), mimeType: z.string() });
const thinking = z.looseObject({ type: z.literal("thinking"), thinking: z.string() });
const toolCall = z.looseObject({
	type: z.literal("toolCall"),
	id: z.string(),
	name: z.string(),
	arguments: z.record(z.string(), z.unknown()),
});
const providerNative = z.looseObject({ type: z.literal("providerNative"), subtype: z.string(), raw: z.unknown() });

const textOrImage = z.discriminatedUnion("type", [text, image]);
export const userContentSchema = z.union([z.string(), z.array(textOrImage)]);
export const editableContentSchema = z.union([
	z.string(),
	z.array(z.discriminatedUnion("type", [text, image, thinking, toolCall, providerNative])),
]);

export const usageSchema = z.looseObject({
	input: count,
	output: count,
	cacheRead: count,
	cacheWrite: count,
	totalTokens: count,
	cost: z.looseObject({ input: amount, output: amount, cacheRead: amount, cacheWrite: amount, total: amount }),
});

const STOP_REASONS = [
	"pending",
	"stop",
	"length",
	"toolUse",
	"error",
	"aborted",
	"deferred",
] as const satisfies readonly StopReason[];

const BY_ROLE = {
	system: z.looseObject({ role: z.literal("system"), content: z.union([z.string(), z.array(text)]), timestamp }),
	user: z.looseObject({ role: z.literal("user"), content: userContentSchema, timestamp }),
	assistant: z.looseObject({
		role: z.literal("assistant"),
		content: z.array(z.discriminatedUnion("type", [text, thinking, toolCall, providerNative])),
		api: z.string(),
		provider: z.string(),
		model: z.string(),
		usage: usageSchema,
		stopReason: z.enum(STOP_REASONS),
		timestamp,
	}),
	toolResult: z.looseObject({
		role: z.literal("toolResult"),
		toolCallId: z.string(),
		toolName: z.string(),
		content: z.array(textOrImage),
		isError: z.boolean(),
		timestamp,
	}),
	configurationUpdate: z.looseObject({
		role: z.literal("configurationUpdate"),
		content: z.array(textOrImage),
		effort: z.string(),
		timestamp,
	}),
	bashExecution: z.looseObject({
		role: z.literal("bashExecution"),
		command: z.string(),
		output: z.string(),
		exitCode: z.number().optional(),
		cancelled: z.boolean(),
		truncated: z.boolean(),
		timestamp,
	}),
	custom: z.looseObject({
		role: z.literal("custom"),
		customType: z.string(),
		content: userContentSchema,
		display: z.boolean(),
		timestamp,
	}),
	branchSummary: z.looseObject({
		role: z.literal("branchSummary"),
		summary: z.string(),
		fromId: z.string().nullable(),
		timestamp,
	}),
	compactionSummary: z.looseObject({
		role: z.literal("compactionSummary"),
		summary: z.string(),
		tokensBefore: count,
		timestamp,
	}),
} satisfies Record<AgentMessage["role"], z.ZodType>;

export const agentMessageSchema = z.discriminatedUnion("role", [
	BY_ROLE.system,
	BY_ROLE.user,
	BY_ROLE.assistant,
	BY_ROLE.toolResult,
	BY_ROLE.configurationUpdate,
	BY_ROLE.bashExecution,
	BY_ROLE.custom,
	BY_ROLE.branchSummary,
	BY_ROLE.compactionSummary,
]);

const agentMessagesSchema = z.array(agentMessageSchema);

/** One transcript message, as data its handlers read. */
export const isAgentMessage = (value: unknown): value is AgentMessage => agentMessageSchema.safeParse(value).success;

/** The loop's transcript messages, as data its handlers read (the Stop hook its last stop reason). */
export const isAgentMessages = (value: unknown): value is AgentMessage[] =>
	agentMessagesSchema.safeParse(value).success;
