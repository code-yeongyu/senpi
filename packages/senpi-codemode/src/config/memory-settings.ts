import { totalmem } from "node:os";
import { type Static, Type } from "typebox";
import type { KernelMemoryThresholds } from "../bridge/memory-protocol.ts";
import type { CodemodeSettings, Environment } from "./settings.ts";

// The longest delay setTimeout honours (2^31 - 1 ms); a longer one fires after 1 ms.
export const MAX_IDLE_PARK_MINUTES = 35_791;

export const memorySettingsSchema = Type.Object(
	{
		gcWatermarkMb: Type.Optional(Type.Number({ minimum: 0 })),
		noticeMb: Type.Optional(Type.Number({ minimum: 0 })),
		ceilingMb: Type.Optional(Type.Number({ minimum: 0 })),
		retainedResultsMb: Type.Optional(Type.Number({ minimum: 0 })),
		retainedImagesMb: Type.Optional(Type.Number({ minimum: 0 })),
		idleParkMinutes: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_IDLE_PARK_MINUTES })),
	},
	{ additionalProperties: false },
);

export type CodemodeMemorySettingsInput = Static<typeof memorySettingsSchema>;

export interface CodemodeMemorySettings {
	/** Live kernel memory from which a finished cell triggers a full collection. */
	readonly gcWatermarkMb: number;
	/** Live kernel memory after collection from which a result names the largest globals. */
	readonly noticeMb: number;
	/** Live kernel memory after collection from which the kernel restarts once its queue drains. */
	readonly ceilingMb: number;
	/** In-memory byte budget (MiB) for settled-cell snapshots kept for `peek`/`list`; 0 keeps only the count cap. */
	readonly retainedResultsMb: number;
	/** Disk budget (MiB) for settled-cell images spilled under the session artifacts dir; 0 keeps only the count cap. */
	readonly retainedImagesMb: number;
	/** Minutes with no cell running or queued before a kernel is closed and restarted on the next cell; absent or 0 never parks. */
	readonly idleParkMinutes?: number;
}

export const DEFAULT_MEMORY_GC_WATERMARK_MB = 256;
export const DEFAULT_MEMORY_NOTICE_MB = 1024;
export const DEFAULT_RETAINED_RESULTS_MB = 32;
export const DEFAULT_RETAINED_IMAGES_MB = 256;
const CEILING_FLOOR_MB = 2048;
const CEILING_CAP_MB = 8192;

export const MEMORY_GC_WATERMARK_ENVIRONMENT_FLAG = "SENPI_CODEMODE_MEMORY_GC_WATERMARK_MB";
export const MEMORY_NOTICE_ENVIRONMENT_FLAG = "SENPI_CODEMODE_MEMORY_NOTICE_MB";
export const MEMORY_CEILING_ENVIRONMENT_FLAG = "SENPI_CODEMODE_MEMORY_CEILING_MB";
export const RETAINED_RESULTS_ENVIRONMENT_FLAG = "SENPI_CODEMODE_RETAINED_RESULTS_MB";
export const RETAINED_IMAGES_ENVIRONMENT_FLAG = "SENPI_CODEMODE_RETAINED_IMAGES_MB";

const MIB = 1024 * 1024;

export function defaultMemoryCeilingMb(totalBytes: number = totalmem()): number {
	const quarterMb = Math.floor(totalBytes / MIB / 4);
	return Math.min(CEILING_CAP_MB, Math.max(CEILING_FLOOR_MB, quarterMb));
}

export function defaultMemorySettings(totalBytes?: number): CodemodeMemorySettings {
	return {
		gcWatermarkMb: DEFAULT_MEMORY_GC_WATERMARK_MB,
		noticeMb: DEFAULT_MEMORY_NOTICE_MB,
		ceilingMb: defaultMemoryCeilingMb(totalBytes),
		retainedResultsMb: DEFAULT_RETAINED_RESULTS_MB,
		retainedImagesMb: DEFAULT_RETAINED_IMAGES_MB,
	};
}

export function mergeMemorySettings(input: CodemodeMemorySettingsInput | undefined): CodemodeMemorySettings {
	const defaults = defaultMemorySettings();
	return {
		gcWatermarkMb: input?.gcWatermarkMb ?? defaults.gcWatermarkMb,
		noticeMb: input?.noticeMb ?? defaults.noticeMb,
		ceilingMb: input?.ceilingMb ?? defaults.ceilingMb,
		retainedResultsMb: input?.retainedResultsMb ?? defaults.retainedResultsMb,
		retainedImagesMb: input?.retainedImagesMb ?? defaults.retainedImagesMb,
		...(input?.idleParkMinutes === undefined ? {} : { idleParkMinutes: input.idleParkMinutes }),
	};
}

export function memorySettingsOrderWarning(memory: CodemodeMemorySettings): string | undefined {
	const enabled = [memory.gcWatermarkMb, memory.noticeMb, memory.ceilingMb].filter((value) => value > 0);
	const ordered = enabled.every((value, index) => index === 0 || (enabled[index - 1] ?? 0) <= value);
	if (ordered) return undefined;
	return `Codemode memory thresholds must satisfy gcWatermarkMb <= noticeMb <= ceilingMb (got ${memory.gcWatermarkMb}, ${memory.noticeMb}, ${memory.ceilingMb}); using the defaults.`;
}

/** File thresholds out of order fall back to the defaults with a warning; the settled-cell budgets are kept. */
export function validatedMemorySettings(input: CodemodeMemorySettingsInput | undefined): {
	readonly settings: CodemodeMemorySettings;
	readonly warnings: readonly string[];
} {
	const merged = mergeMemorySettings(input);
	const warning = memorySettingsOrderWarning(merged);
	if (warning === undefined) return { settings: merged, warnings: [] };
	const defaults = defaultMemorySettings();
	return {
		settings: {
			...defaults,
			retainedResultsMb: merged.retainedResultsMb,
			retainedImagesMb: merged.retainedImagesMb,
			...(merged.idleParkMinutes === undefined ? {} : { idleParkMinutes: merged.idleParkMinutes }),
		},
		warnings: [warning],
	};
}

/**
 * Environment overrides win over the settings file; `0` disables a threshold, and a malformed value is
 * ignored. Thresholds out of order after the overrides fall back to the defaults.
 */
export function resolveKernelMemoryThresholds(
	memory: CodemodeMemorySettings | undefined,
	env: Environment = process.env,
): KernelMemoryThresholds {
	const base = memory ?? defaultMemorySettings();
	const resolved: CodemodeMemorySettings = {
		...base,
		gcWatermarkMb: megabytesOverride(env[MEMORY_GC_WATERMARK_ENVIRONMENT_FLAG]) ?? base.gcWatermarkMb,
		noticeMb: megabytesOverride(env[MEMORY_NOTICE_ENVIRONMENT_FLAG]) ?? base.noticeMb,
		ceilingMb: megabytesOverride(env[MEMORY_CEILING_ENVIRONMENT_FLAG]) ?? base.ceilingMb,
	};
	const effective = memorySettingsOrderWarning(resolved) === undefined ? resolved : defaultMemorySettings();
	return {
		gcWatermarkBytes: Math.round(effective.gcWatermarkMb * MIB),
		noticeBytes: Math.round(effective.noticeMb * MIB),
		ceilingBytes: Math.round(effective.ceilingMb * MIB),
	};
}

/** Settled-cell in-memory snapshot byte budget; the environment override accepts 0 (count cap only). */
export function resolveRetainedResultsBytes(settings: CodemodeSettings, env: Environment = process.env): number {
	const megabytes =
		nonNegativeIntegerOverride(env[RETAINED_RESULTS_ENVIRONMENT_FLAG]) ??
		settings.memory?.retainedResultsMb ??
		DEFAULT_RETAINED_RESULTS_MB;
	return megabytes * MIB;
}

/** Settled-cell image spill disk budget; the environment override accepts 0 (count cap only). */
export function resolveRetainedImagesBytes(settings: CodemodeSettings, env: Environment = process.env): number {
	const megabytes =
		nonNegativeIntegerOverride(env[RETAINED_IMAGES_ENVIRONMENT_FLAG]) ??
		settings.memory?.retainedImagesMb ??
		DEFAULT_RETAINED_IMAGES_MB;
	return megabytes * MIB;
}

function megabytesOverride(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function nonNegativeIntegerOverride(value: string | undefined): number | undefined {
	if (value === undefined || !/^\s*\d+\s*$/u.test(value)) return undefined;
	return Number.parseInt(value, 10);
}
