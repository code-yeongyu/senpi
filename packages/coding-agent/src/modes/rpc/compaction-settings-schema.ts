import type { CompactionSettings } from "../../core/compaction/index.ts";
import { z } from "zod";
import { count } from "./agent-message-schema.ts";

const flag = z.boolean().optional();
const ratio = z.number().min(0).max(1);

// Every field of the settings a compaction preparation carries, with its bounds, and no other (strict): the hand refuses a
// value a session's own settings resolver would never produce, or a field it does not know, rather than handing it to the
// user's compaction handlers.
const SHAPE = {
	enabled: z.boolean(),
	reserveTokens: count,
	keepRecentTokens: count,
	speculativeEnabled: flag,
	speculativeFraction: ratio.optional(),
	speculativeCooldownMs: count.optional(),
	restorationEnabled: flag,
	restorationMaxItems: z.int().nonnegative().optional(),
	restorationMaxTokensPerItem: count.optional(),
	restorationMaxTotalTokens: count.optional(),
	restorationContextRatio: ratio.optional(),
	idleCompactionEnabled: flag,
	summarizationMaxDurationMs: z.number().positive().optional(),
	graceBandEnabled: flag,
	toolAdmissionEnabled: flag,
	reminderEnabled: flag,
	reserveScalingEnabled: flag,
	speculativeLeadTokens: count.optional(),
	model: z.string().optional(),
} satisfies { [K in keyof Required<CompactionSettings>]: z.ZodType };

const compactionSettingsSchema = z.strictObject(SHAPE);

export const isCompactionSettings = (value: unknown): value is CompactionSettings =>
	compactionSettingsSchema.safeParse(value).success;
