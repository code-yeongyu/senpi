import type { CompactionSettings } from "../../core/compaction/index.ts";
import { z } from "zod";
import { amount } from "./agent-message-schema.ts";

const flag = z.boolean().optional();
const ratio = z.number().min(0).max(1);

// Every field of the settings a compaction preparation carries, with its bounds: the hand refuses a value a session's own
// settings resolver would never produce, rather than handing it to the user's compaction handlers.
// The settings are user-written numbers the `CompactionSettings` type does not require to be whole, so token budgets
// and durations are non-negative amounts here, not integer counts.
const SHAPE = {
	enabled: z.boolean(),
	reserveTokens: amount,
	keepRecentTokens: amount,
	speculativeEnabled: flag,
	speculativeFraction: ratio.optional(),
	speculativeCooldownMs: amount.optional(),
	restorationEnabled: flag,
	restorationMaxItems: z.int().nonnegative().optional(),
	restorationMaxTokensPerItem: amount.optional(),
	restorationMaxTotalTokens: amount.optional(),
	restorationContextRatio: ratio.optional(),
	idleCompactionEnabled: flag,
	summarizationMaxDurationMs: z.number().positive().optional(),
	graceBandEnabled: flag,
	toolAdmissionEnabled: flag,
	reminderEnabled: flag,
	reserveScalingEnabled: flag,
	speculativeLeadTokens: amount.optional(),
	model: z.string().optional(),
} satisfies { [K in keyof Required<CompactionSettings>]: z.ZodType };

const compactionSettingsSchema = z.looseObject(SHAPE);

export const isCompactionSettings = (value: unknown): value is CompactionSettings =>
	compactionSettingsSchema.safeParse(value).success;
