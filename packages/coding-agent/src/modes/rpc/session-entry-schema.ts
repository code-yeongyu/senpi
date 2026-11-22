import type { InputSource } from "../../core/extensions/types.ts";
import type { CompactionEntry, CustomEntry, SessionEntry } from "../../core/session-manager.ts";
import { z } from "zod";
import {
	agentMessageSchema,
	count,
	editableContentSchema,
	usageSchema,
	userContentSchema,
} from "./agent-message-schema.ts";

// The hand's parse of the loop's session entries (senpi#5898): every entry type, each with the fields its readers rely
// on. Objects are deliberately loose, for the reason transcript messages are (agent-message-schema.ts): entries are the
// loop's session record, and a newer loop's optional entry fields reach handlers untouched.

export const INPUT_SOURCES = ["interactive", "rpc", "extension"] as const satisfies readonly InputSource[];

const entry = <T extends SessionEntry["type"], S extends z.ZodRawShape>(type: T, shape: S) =>
	z.looseObject({
		type: z.literal(type),
		id: z.string(),
		parentId: z.string().nullable(),
		timestamp: z.string(),
		...shape,
	});

const BY_TYPE = {
	message: entry("message", { message: agentMessageSchema, inputSource: z.enum(INPUT_SOURCES).optional() }),
	thinking_level_change: entry("thinking_level_change", { thinkingLevel: z.string() }),
	configuration_update: entry("configuration_update", { reasoning: z.looseObject({ effort: z.string() }) }),
	model_change: entry("model_change", { provider: z.string(), modelId: z.string() }),
	model_change_rejected: entry("model_change_rejected", {
		provider: z.string(),
		modelId: z.string(),
		reason: z.enum(["context-budget", "auth"]),
		detail: z.string(),
	}),
	usage: entry("usage", { kind: z.string(), provider: z.string(), model: z.string(), usage: usageSchema }),
	compaction: entry("compaction", {
		summary: z.string(),
		firstKeptEntryId: z.string(),
		tokensBefore: count,
		usage: usageSchema.optional(),
	}),
	branch_summary: entry("branch_summary", { fromId: z.string(), summary: z.string(), usage: usageSchema.optional() }),
	custom: entry("custom", { customType: z.string() }),
	custom_message: entry("custom_message", {
		customType: z.string(),
		content: userContentSchema,
		display: z.boolean(),
	}),
	context_edit: entry("context_edit", {
		targetId: z.string(),
		replacement: z.looseObject({ content: editableContentSchema }).nullable(),
	}),
	label: entry("label", { targetId: z.string(), label: z.string().optional() }),
	session_info: entry("session_info", { name: z.string().optional() }),
} satisfies { [T in SessionEntry["type"]]: z.ZodType };

const sessionEntrySchema = z.discriminatedUnion("type", [
	BY_TYPE.message,
	BY_TYPE.thinking_level_change,
	BY_TYPE.configuration_update,
	BY_TYPE.model_change,
	BY_TYPE.model_change_rejected,
	BY_TYPE.usage,
	BY_TYPE.compaction,
	BY_TYPE.branch_summary,
	BY_TYPE.custom,
	BY_TYPE.custom_message,
	BY_TYPE.context_edit,
	BY_TYPE.label,
	BY_TYPE.session_info,
]);

export const isSessionEntry = (value: unknown): value is SessionEntry => sessionEntrySchema.safeParse(value).success;
export const isCustomEntry = (value: unknown): value is CustomEntry => BY_TYPE.custom.safeParse(value).success;
export const isCompactionEntry = (value: unknown): value is CompactionEntry =>
	BY_TYPE.compaction.safeParse(value).success;
