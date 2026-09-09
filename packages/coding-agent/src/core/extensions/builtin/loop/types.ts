/**
 * Shared state model for the `/loop` builtin extension.
 *
 * This module is the single type home for the whole feature: the store, the scheduler,
 * the `schedule_wakeup` tool, the tick-prompt builder, and the status presenter all
 * consume these declarations. It is data-only — no clock access, no I/O, no timers.
 */

/** Milliseconds since the Unix epoch. */
export type EpochMs = number;

/** Identifier of a single `/loop` job within one session. */
export type LoopId = string;
/** Identifier of one dynamic wakeup (model-scheduled or keepalive fallback). */
export type WakeupId = string;
/** Identifier of one dispatched tick delivery, used to anchor sentinel reminders. */
export type DeliveryId = string;

export const LOOP_STATE_VERSION = 1;
export type LoopStateVersion = typeof LOOP_STATE_VERSION;

export const LOOP_KINDS = ["fixed", "dynamic"] as const;
export type LoopKind = (typeof LOOP_KINDS)[number];

export const LOOP_SENTINELS = [
	"<<autonomous-loop>>",
	"<<autonomous-loop-dynamic>>",
	"<<loop.md>>",
	"<<loop.md-dynamic>>",
] as const;
export type LoopSentinel = (typeof LOOP_SENTINELS)[number];

export type LoopPayload =
	| {
			readonly type: "prompt";
			/** Exact parsed prompt, including a leading slash command. */
			readonly prompt: string;
	  }
	| {
			readonly type: "sentinel";
			readonly sentinel: LoopSentinel;
	  };

export const LOOP_PHASES = ["starting", "waiting", "queued", "running", "suspended", "ended"] as const;
export type LoopPhase = (typeof LOOP_PHASES)[number];

/**
 * Terminal reasons, exhaustively.
 *
 * There is deliberately NO `session_closed`: every senpi shutdown reason
 * (`quit|reload|new|resume|fork`) leaves the session resumable, so shutdown SUSPENDS a
 * loop instead of ending it, and no code path can reach a session-closed terminal state.
 */
export const LOOP_END_REASONS = [
	"stopped",
	"keepalive_exhausted",
	"expired",
	"tick_budget_exhausted",
	"error",
] as const;
export type LoopEndReason = (typeof LOOP_END_REASONS)[number];

export type LoopLifecycle =
	| {
			readonly phase: Exclude<LoopPhase, "ended">;
			readonly endedAt?: never;
			readonly endReason?: never;
			readonly endDetail?: never;
	  }
	| {
			readonly phase: "ended";
			readonly endedAt: EpochMs;
			readonly endReason: LoopEndReason;
			/** Machine-stable subtype (e.g. `superseded`) or human-readable error detail. */
			readonly endDetail?: string;
	  };

export interface LoopFileFingerprint {
	readonly path: string;
	readonly mtimeMs: number;
	readonly size: number;
	/** SHA-256 of the model-visible, truncated representation. */
	readonly contentHash: string;
	/** Delivery that carried the full loop-file block a reminder can point back to. */
	readonly anchorDeliveryId: DeliveryId;
}

export interface SentinelDeliveryState {
	/**
	 * True after a full autonomous preamble has been delivered and its anchor is still
	 * believed to be present in the compaction-aware context.
	 */
	readonly autonomousPreambleDelivered: boolean;

	/**
	 * Last full loop-file representation delivered. Null before the first delivery and
	 * after the file disappears.
	 */
	readonly lastLoopFileDelivered: LoopFileFingerprint | null;

	/**
	 * Set by an accepted compaction or a failed anchor reconstruction. The next fire must
	 * deliver a full preamble regardless of the fields above.
	 */
	readonly forceFullDelivery: boolean;
}

export const REQUESTED_INTERVAL_UNITS = ["s", "m", "h", "d"] as const;
export type RequestedIntervalUnit = (typeof REQUESTED_INTERVAL_UNITS)[number];

export const EFFECTIVE_INTERVAL_UNITS = ["m", "h", "d"] as const;
export type EffectiveIntervalUnit = (typeof EFFECTIVE_INTERVAL_UNITS)[number];

export interface RequestedInterval {
	readonly value: number;
	readonly unit: RequestedIntervalUnit;
	/** Exact token parsed from the command, e.g. `90m`. */
	readonly raw: string;
}

export interface EffectiveInterval {
	readonly value: number;
	readonly unit: EffectiveIntervalUnit;
	readonly human: string;
	readonly rounded: boolean;
	readonly roundingNotice?: string;
}

export const LOOP_WAKE_SOURCE_KINDS = ["terminal-monitor", "terminal-background-session", "task", "other"] as const;
export type LoopWakeSourceKind = (typeof LOOP_WAKE_SOURCE_KINDS)[number];

export interface LoopWakeSource {
	readonly source: LoopWakeSourceKind;
	readonly id: string;
	readonly description?: string;
	readonly createdAt: EpochMs;
}

export interface PendingWakeup {
	readonly id: WakeupId;
	readonly loopId: LoopId;
	readonly kind: "dynamic";
	readonly source: "model" | "keepalive";

	readonly requestedDelaySeconds: number;
	/** Effective delay after the executor clamp to `[60, 3600]`. */
	readonly delaySeconds: number;
	readonly dueAt: EpochMs;

	readonly reason: string;
	/** Preserved verbatim after non-blank validation. */
	readonly prompt: string;
	readonly noop: boolean;

	readonly createdAt: EpochMs;
}

export interface LoopEntryFields {
	readonly id: LoopId;

	/** Exact arguments after `/loop `, excluding the command name. */
	readonly originalArgs: string;

	/**
	 * Canonical re-entry text. A bare invocation is `/loop`; otherwise this is
	 * `"/loop " + originalArgs`.
	 */
	readonly reentryPrompt: string;

	readonly payload: LoopPayload;

	readonly createdAt: EpochMs;
	readonly lastFiredAt: EpochMs | null;
	readonly expiresAt: EpochMs;

	/**
	 * Scheduled wall-clock occurrence most recently delivered. Prevents duplicate delivery
	 * after sleep, resume, or a stale timer callback.
	 */
	readonly lastScheduledForAt: EpochMs | null;

	/**
	 * At most one extra fire may be pending while this loop already has a queued or
	 * running delivery. Missed occurrences coalesce into this flag; they are never replayed.
	 */
	readonly coalescedFirePending: boolean;
	readonly queuedForAt: EpochMs | null;

	/**
	 * Consecutive dynamic iterations that scheduled with `noop: true`. User input or a
	 * non-noop iteration resets it.
	 */
	readonly noopStreak: number;

	/** Ticks dispatched so far; drives the `tick_budget_exhausted` safety valve. */
	readonly tickCount: number;

	readonly sentinelDelivery: SentinelDeliveryState;

	/**
	 * Wake-source IDs created or adopted by this loop, used to attribute
	 * monitor/task notifications to a loop iteration.
	 */
	readonly wakeSources: readonly LoopWakeSource[];
}

export type LoopEntryBase = LoopEntryFields & LoopLifecycle & { readonly kind: LoopKind };

export type FixedCronEntry = LoopEntryFields &
	LoopLifecycle & {
		readonly kind: "fixed";
		readonly requestedInterval: RequestedInterval;
		readonly effectiveInterval: EffectiveInterval;
		/** Display-only restricted cron string; scheduling uses `intervalMs` + `nextFireAt`. */
		readonly cronExpression: string;

		/** Next occurrence strictly later than the last scheduler observation. */
		readonly nextFireAt: EpochMs;
		readonly intervalMs: number;

		readonly pendingWakeup?: never;
		/** Fixed ticks are re-armed by the schedule itself, so keepalive never applies. */
		readonly keepaliveCredit?: never;
	};

export type DynamicCronEntry = LoopEntryFields &
	LoopLifecycle & {
		readonly kind: "dynamic";
		readonly requestedInterval?: never;
		readonly effectiveInterval?: never;
		readonly cronExpression?: never;
		readonly nextFireAt?: never;
		readonly intervalMs?: never;

		readonly pendingWakeup: PendingWakeup | null;

		/**
		 * One means an omitted `schedule_wakeup` may consume one fallback. Zero means
		 * another omission ends the loop with `keepalive_exhausted`. A successful model
		 * schedule resets this to one.
		 */
		readonly keepaliveCredit: 0 | 1;
	};

export type CronEntry = FixedCronEntry | DynamicCronEntry;

export interface LoopState {
	readonly version: LoopStateVersion;
	readonly sessionId: string;

	/**
	 * Includes ended records so a resume never resurrects a terminal loop.
	 */
	readonly entries: Readonly<Record<LoopId, CronEntry>>;

	/** At most one dynamic loop; fixed loops may coexist with it and with each other. */
	readonly activeDynamicId: LoopId | null;

	readonly updatedAt: EpochMs;
}

/** Locates the per-session sidecar file. Timer handles are never persisted. */
export interface LoopStoreRef {
	readonly baseDir: string;
	readonly sessionId: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
