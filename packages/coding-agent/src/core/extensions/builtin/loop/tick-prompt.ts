/**
 * Tick-prompt templates with cache-friendly sentinel expansion.
 *
 * `buildTickMessage` is pure: it reads no files, touches no clock, and mutates nothing.
 * The caller resolves the loop file (see `loopfile.ts`) and hands the snapshot in; this
 * module decides full-vs-reminder delivery, renders the tick text, and returns the
 * updated sentinel delivery state to persist.
 *
 * Cache discipline: the long instruction blocks are delivered once (the "anchor") and
 * later ticks send a short reminder that points back at that anchored message, so the
 * cached message prefix stays stable across fires.
 */

import type {
	DeliveryId,
	LoopFileFingerprint,
	LoopId,
	LoopPayload,
	LoopSentinel,
	SentinelDeliveryState,
} from "./types.ts";

export type LoopMode = "fixed" | "dynamic";

/** `prompt` covers a verbatim user prompt; sentinels alternate between full and reminder. */
export type TickDelivery = "full" | "reminder" | "prompt";

/** Resolved loop-file state for this fire, produced by the caller's loop-file reader. */
export type LoopFileSnapshot =
	| { readonly present: false }
	| {
			readonly present: true;
			readonly path: string;
			/** Model-visible (already truncated) representation. */
			readonly content: string;
			readonly mtimeMs: number;
			readonly size: number;
			/** SHA-256 of the model-visible representation. */
			readonly contentHash: string;
	  };

export interface TickPromptInput {
	readonly loopId: LoopId;
	readonly deliveryId: DeliveryId;
	readonly mode: LoopMode;
	readonly payload: LoopPayload;
	/** Canonical re-entry text, e.g. `/loop check the deploy` or `/loop`. */
	readonly reentryPrompt: string;
	readonly deliveryState: SentinelDeliveryState;
	readonly loopFile: LoopFileSnapshot;
}

export interface LoopTickDetails {
	readonly loopId: LoopId;
	readonly deliveryId: DeliveryId;
	readonly mode: LoopMode;
	readonly delivery: TickDelivery;
	readonly sentinel?: LoopSentinel;
	readonly loopFile?: LoopFileFingerprint;
}

export interface TickPromptResult {
	readonly text: string;
	readonly delivery: TickDelivery;
	readonly details: LoopTickDetails;
	/** Delivery state to persist after this tick is dispatched. */
	readonly deliveryState: SentinelDeliveryState;
}

const LOOP_FILE_HEADER = "# /loop tick - loop.md tasks";
const AUTONOMOUS_HEADER = "# Autonomous loop tick";
const DYNAMIC_PACING_SUFFIX = " (dynamic pacing)";

const FIXED_RESCHEDULE_RULE = [
	"The fixed recurring schedule fires the next tick automatically - do not call `schedule_wakeup` from this tick.",
	"If this tick errors, the schedule stays armed and the next occurrence still fires.",
].join("\n");

function dynamicRescheduleRule(reentryPrompt: string): string {
	return [
		`As the last action of this turn, call \`schedule_wakeup\` with \`prompt: ${JSON.stringify(reentryPrompt)}\` so the loop stays alive; a turn that ends without it burns the single keepalive fallback and then the loop ends.`,
		"To end the loop instead, call `schedule_wakeup` with `{ stop: true }` and a reason.",
		"When the next step is gated on observable state, do not sleep or poll: watch terminal output with `monitor`, inspect it with `bash_output`, stop the watcher with `kill_bash`, and let task-notification wakeups resume this loop. With one of those armed, the scheduled delay is only a fallback heartbeat (1200-1800s is the normal idle range).",
		"Set `noop: true` only when this tick found no actionable change, and notify the user only on changes worth acting on - not once per tick.",
	].join("\n");
}

function modeRule(mode: LoopMode, reentryPrompt: string): string {
	return mode === "fixed" ? FIXED_RESCHEDULE_RULE : dynamicRescheduleRule(reentryPrompt);
}

function header(base: string, mode: LoopMode): string {
	return mode === "dynamic" ? `${base}${DYNAMIC_PACING_SUFFIX}` : base;
}

const AUTONOMOUS_FULL_BODY = [
	"No loop-tasks file is configured, so run the standard autonomous maintenance pass for this tick:",
	"",
	"1. Inspect current state: active tasks, running terminal commands and monitors, and any delegated child work.",
	"2. Make concrete progress where progress is possible; do not merely narrate.",
	"3. Avoid repeating unchanged status - stay silent when nothing moved.",
	"4. Surface only actionable state changes to the user, once per state change.",
].join("\n");

const AUTONOMOUS_REMINDER_BODY =
	"Continue the autonomous maintenance pass established by the most recent full autonomous loop instruction message in this conversation. Re-read that anchored message and perform the next applicable work.";

const LOOP_FILE_REMINDER_BODY =
	"Continue the loop.md tasks established by the most recent full loop.md instruction message in this conversation. Re-read that anchored message and perform the next applicable work.";

const LOOP_FILE_INTRO =
	"The user configured a loop-tasks file. Work through the tasks defined below; these are the instructions for this tick and every subsequent tick (the reminder on later fires refers back to this message).";

const LOOP_FILE_ABSENT_BODY =
	"The loop-tasks file used by this loop is currently absent. Perform the autonomous maintenance check for this tick. Keep the loop alive so a later tick can pick up the file if it reappears.";

function joinBlocks(blocks: readonly string[]): string {
	return blocks.filter((block) => block.length > 0).join("\n\n");
}

function sentinelOf(payload: LoopPayload): LoopSentinel | undefined {
	return payload.type === "sentinel" ? payload.sentinel : undefined;
}

function isLoopFileSentinel(sentinel: LoopSentinel): boolean {
	return sentinel === "<<loop.md>>" || sentinel === "<<loop.md-dynamic>>";
}

function fingerprintChanged(
	previous: LoopFileFingerprint,
	snapshot: Extract<LoopFileSnapshot, { present: true }>,
): boolean {
	return (
		previous.path !== snapshot.path ||
		previous.mtimeMs !== snapshot.mtimeMs ||
		previous.size !== snapshot.size ||
		previous.contentHash !== snapshot.contentHash
	);
}

function buildPromptTick(input: TickPromptInput, prompt: string): TickPromptResult {
	const text = joinBlocks([prompt, modeRule(input.mode, input.reentryPrompt)]);
	return {
		text,
		delivery: "prompt",
		details: {
			loopId: input.loopId,
			deliveryId: input.deliveryId,
			mode: input.mode,
			delivery: "prompt",
		},
		// A verbatim prompt tick carries no sentinel instructions, so nothing is anchored.
		deliveryState: input.deliveryState,
	};
}

function buildLoopFileTick(input: TickPromptInput, sentinel: LoopSentinel): TickPromptResult {
	const { deliveryState, loopFile, mode } = input;
	const rule = modeRule(mode, input.reentryPrompt);

	if (!loopFile.present) {
		// Absence keeps the loop.md sentinel: a later tick must detect reappearance.
		const text = joinBlocks([header("# /loop tick - loop.md absent", mode), LOOP_FILE_ABSENT_BODY, rule]);
		return {
			text,
			delivery: "full",
			details: {
				loopId: input.loopId,
				deliveryId: input.deliveryId,
				mode,
				delivery: "full",
				sentinel,
			},
			deliveryState: {
				...deliveryState,
				lastLoopFileDelivered: null,
				forceFullDelivery: false,
			},
		};
	}

	const previous = deliveryState.lastLoopFileDelivered;
	const full = deliveryState.forceFullDelivery || previous === null || fingerprintChanged(previous, loopFile);

	if (!full) {
		return {
			text: joinBlocks([LOOP_FILE_HEADER, LOOP_FILE_REMINDER_BODY, rule]),
			delivery: "reminder",
			details: {
				loopId: input.loopId,
				deliveryId: input.deliveryId,
				mode,
				delivery: "reminder",
				sentinel,
				loopFile: previous,
			},
			deliveryState,
		};
	}

	const fingerprint: LoopFileFingerprint = {
		path: loopFile.path,
		mtimeMs: loopFile.mtimeMs,
		size: loopFile.size,
		contentHash: loopFile.contentHash,
		anchorDeliveryId: input.deliveryId,
	};

	const text = joinBlocks([LOOP_FILE_HEADER, LOOP_FILE_INTRO, `---\n${loopFile.content}\n---`, rule]);

	return {
		text,
		delivery: "full",
		details: {
			loopId: input.loopId,
			deliveryId: input.deliveryId,
			mode,
			delivery: "full",
			sentinel,
			loopFile: fingerprint,
		},
		deliveryState: {
			...deliveryState,
			lastLoopFileDelivered: fingerprint,
			forceFullDelivery: false,
		},
	};
}

function buildAutonomousTick(input: TickPromptInput, sentinel: LoopSentinel): TickPromptResult {
	const { deliveryState, mode } = input;
	const rule = modeRule(mode, input.reentryPrompt);
	const full = deliveryState.forceFullDelivery || !deliveryState.autonomousPreambleDelivered;
	const head = header(AUTONOMOUS_HEADER, mode);

	const text = full
		? joinBlocks([head, AUTONOMOUS_FULL_BODY, rule])
		: joinBlocks([head, AUTONOMOUS_REMINDER_BODY, rule]);

	return {
		text,
		delivery: full ? "full" : "reminder",
		details: {
			loopId: input.loopId,
			deliveryId: input.deliveryId,
			mode,
			delivery: full ? "full" : "reminder",
			sentinel,
		},
		deliveryState: full
			? { ...deliveryState, autonomousPreambleDelivered: true, forceFullDelivery: false }
			: deliveryState,
	};
}

/**
 * Render one tick message plus the delivery state to persist afterwards.
 *
 * Full delivery happens on the first sentinel delivery, when `forceFullDelivery` is set
 * (accepted compaction or a missing anchor on resume), when the loop file's fingerprint
 * changed, or when the file reappeared after absence. Otherwise the tick is a short
 * reminder anchored to the last full message.
 */
export function buildTickMessage(input: TickPromptInput): TickPromptResult {
	if (input.payload.type === "prompt") {
		return buildPromptTick(input, input.payload.prompt);
	}
	const sentinel = sentinelOf(input.payload);
	if (sentinel === undefined) {
		throw new Error("loop tick payload is a sentinel without a sentinel value");
	}
	return isLoopFileSentinel(sentinel) ? buildLoopFileTick(input, sentinel) : buildAutonomousTick(input, sentinel);
}
