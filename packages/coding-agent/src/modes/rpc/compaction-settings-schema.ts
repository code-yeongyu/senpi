import type { CompactionSettings } from "../../core/compaction/index.ts";
import { z } from "zod";
import { amount } from "./agent-message-schema.ts";

// User-written settings: the `CompactionSettings` type allows any non-negative number here, so the hand does too.
const count = amount;

const flag = z.boolean().optional();
const ratio = z.number().min(0).max(1);

// Every field of the settings a compaction preparation carries, with its bounds: the hand refuses a value a session's own
// settings resolver would never produce, rather than handing it to the user's compaction handlers.
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
	reserveScalingEnabled: flag,
	speculativeLeadTokens: count.optional(),
	model: z.string().optional(),
} satisfies { [K in keyof Required<CompactionSettings>]: z.ZodType };

const compactionSettingsSchema = z.looseObject(SHAPE);

export const isCompactionSettings = (value: unknown): value is CompactionSettings =>
	compactionSettingsSchema.safeParse(value).success;
