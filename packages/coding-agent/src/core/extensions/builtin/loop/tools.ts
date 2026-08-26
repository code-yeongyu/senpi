/**
 * The `schedule_wakeup` model tool: the ONLY model-callable surface of the `/loop`
 * extension. It lets a dynamic (self-paced) loop pick its own next delay, or end itself.
 *
 * Two deliberate shape decisions:
 * - The TypeBox schema is a FLAT object with no root union. Several provider payload
 *   conversions rebuild tool schemas from top-level `properties` only, so a root
 *   `anyOf` would reach the model as an empty schema (same reasoning as
 *   `terminal/tools/monitor.ts`). Branch requirements are enforced in `execute`.
 * - `delaySeconds` carries NO schema `minimum`/`maximum`. The contract clamps
 *   out-of-range integers instead of rejecting them, and schema bounds would make the
 *   clamp unreachable.
 *
 * Scheduler state is never mutated here: every effect goes through the injected
 * `ScheduleWakeupSchedulerPort`.
 */

import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "../../types.ts";
import type { EpochMs, LoopId, WakeupId } from "./types.ts";

/** Model-visible tool name. */
export const SCHEDULE_WAKEUP_TOOL = "schedule_wakeup";

/** Inclusive bounds the executor clamps `delaySeconds` into. */
export const MIN_WAKEUP_DELAY_SECONDS = 60;
export const MAX_WAKEUP_DELAY_SECONDS = 3600;

export const SCHEDULE_WAKEUP_DESCRIPTION = `Schedule when to resume work in /loop dynamic mode. Always pass the \`prompt\` argument unless stopping. Call this as the last action before ending a dynamic loop iteration so the loop remains alive; call with \`stop: true\` to end the active dynamic loop immediately.

\`delaySeconds\` is clamped to ${MIN_WAKEUP_DELAY_SECONDS}-${MAX_WAKEUP_DELAY_SECONDS} seconds. For idle polling, normally use 1200-1800 seconds. Avoid choosing 300 seconds merely to poll: short polling repeatedly loses prompt-cache value on many API paths. When work is gated on observable terminal state, use \`monitor\` instead of sleeping or polling; inspect it with \`bash_output\` and stop the watcher with \`kill_bash\`. For delegated work, use the available \`task\` output and control tools and let task completion notifications wake the session. When a monitor or task notification is the primary wake source, the scheduled delay is only a fallback heartbeat.

For normal dynamic re-entry, set \`prompt\` to the complete original command, for example \`/loop check the deploy\`, preserving the user's text verbatim. Set \`noop: true\` only when this iteration found no actionable change; consecutive noop iterations are folded in the terminal view. Omit \`noop\` when stopping. Notify the user only when state changes in a way worth acting on, not once per tick.`;

export const scheduleWakeupSchema = Type.Object(
	{
		delaySeconds: Type.Optional(
			Type.Integer({
				description: `Dynamic loop delay in seconds. Values are clamped to ${MIN_WAKEUP_DELAY_SECONDS}-${MAX_WAKEUP_DELAY_SECONDS}.`,
			}),
		),
		reason: Type.String({
			minLength: 1,
			description: "Why this wakeup or stop is appropriate. Must not be blank.",
		}),
		prompt: Type.Optional(
			Type.String({
				description:
					"Prompt to dispatch when the wakeup fires. Required unless stop is true; preserve the original /loop command verbatim for normal dynamic re-entry.",
			}),
		),
		stop: Type.Optional(
			Type.Boolean({
				description: "End the active dynamic loop immediately instead of scheduling another wakeup.",
			}),
		),
		noop: Type.Optional(
			Type.Boolean({
				description:
					"True when this iteration observed no actionable change. Consecutive noop iterations are folded in the terminal view. Omit when stopping.",
			}),
		),
	},
	{ additionalProperties: false },
);

/** Runtime-validated parameter shape; the schema itself stays flat and permissive. */
export interface ScheduleWakeupParams {
	readonly delaySeconds?: number;
	readonly reason: string;
	readonly prompt?: string;
	readonly stop?: boolean;
	readonly noop?: boolean;
}

export interface ScheduleWakeupScheduledDetails {
	readonly ok: true;
	readonly action: "scheduled";
	readonly loopId: LoopId;
	readonly wakeupId: WakeupId;
	readonly replacedWakeupId?: WakeupId;

	/** Integer the model asked for, before the clamp. */
	readonly requestedDelaySeconds: number;
	/** Effective delay after clamping to `[60, 3600]`. */
	readonly delaySeconds: number;
	readonly clamped: boolean;
	readonly dueAt: EpochMs;

	readonly reason: string;
	/** Preserved verbatim after the non-blank check. */
	readonly prompt: string;
	readonly noop: boolean;
	readonly noopStreak: number;
}

export interface ScheduleWakeupStoppedDetails {
	readonly ok: true;
	readonly action: "stopped";
	readonly loopId: LoopId;
	readonly terminalReason: "stopped";
	readonly reason: string;
	readonly endedAt: EpochMs;
	/** Fields accepted for model compatibility but not applied. */
	readonly ignoredFields: readonly ScheduleWakeupIgnorableField[];
}

export type ScheduleWakeupIgnorableField = "delaySeconds" | "prompt";

export type ScheduleWakeupDetails = ScheduleWakeupScheduledDetails | ScheduleWakeupStoppedDetails;

/**
 * Which loop, if any, this tool call belongs to. `null` means no loop context at all;
 * a `fixed` target means the call came from a fixed tick, whose schedule re-arms itself.
 */
export type ScheduleWakeupTarget = { readonly kind: "dynamic" | "fixed"; readonly loopId: LoopId } | null;

export interface ScheduleWakeupRequest {
	readonly loopId: LoopId;
	readonly requestedDelaySeconds: number;
	readonly delaySeconds: number;
	readonly reason: string;
	readonly prompt: string;
	readonly noop: boolean;
}

export interface ScheduleWakeupOutcome {
	readonly wakeupId: WakeupId;
	/** Set when this schedule replaced a still-pending wakeup for the same loop. */
	readonly replacedWakeupId?: WakeupId;
	readonly dueAt: EpochMs;
	readonly noopStreak: number;
}

export interface StopDynamicLoopRequest {
	readonly loopId: LoopId;
	readonly reason: string;
}

export interface StopDynamicLoopOutcome {
	readonly endedAt: EpochMs;
}

/**
 * Minimal scheduler surface this tool needs. Declared locally so the tool module stays
 * independent of the scheduler implementation and testable with a fake.
 */
export interface ScheduleWakeupSchedulerPort {
	/** Loop the current turn is attributed to, resolved at call time. */
	getWakeupTarget(): ScheduleWakeupTarget;
	scheduleWakeup(request: ScheduleWakeupRequest): Promise<ScheduleWakeupOutcome>;
	stopDynamicLoop(request: StopDynamicLoopRequest): Promise<StopDynamicLoopOutcome>;
}

export interface LoopToolRegistrationDeps {
	readonly scheduler: ScheduleWakeupSchedulerPort;
}

export const NO_ACTIVE_DYNAMIC_LOOP_ERROR = `${SCHEDULE_WAKEUP_TOOL} can only be used while a dynamic /loop is active.`;
export const FIXED_TICK_ERROR = `This is a fixed /loop tick; the recurring schedule re-arms automatically. Do not call ${SCHEDULE_WAKEUP_TOOL}.`;
export const MISSING_PROMPT_ERROR = "prompt is required and must be non-empty unless stop is true.";
export const MISSING_DELAY_ERROR = "delaySeconds is required unless stop is true.";
export const NON_INTEGER_DELAY_ERROR = "delaySeconds must be a finite integer number of seconds.";
export const BLANK_REASON_ERROR = "reason is required and must be non-empty.";
export const NOOP_WITH_STOP_ERROR = "noop must be omitted when stop is true.";

function clampDelaySeconds(requested: number): number {
	return Math.min(MAX_WAKEUP_DELAY_SECONDS, Math.max(MIN_WAKEUP_DELAY_SECONDS, requested));
}

function resolveDynamicLoopId(scheduler: ScheduleWakeupSchedulerPort): LoopId {
	const target = scheduler.getWakeupTarget();
	if (target === null) throw new Error(NO_ACTIVE_DYNAMIC_LOOP_ERROR);
	if (target.kind === "fixed") throw new Error(FIXED_TICK_ERROR);
	return target.loopId;
}

function requireReason(reason: string): string {
	const trimmed = typeof reason === "string" ? reason.trim() : "";
	if (trimmed.length === 0) throw new Error(BLANK_REASON_ERROR);
	return trimmed;
}

function collectIgnoredFields(params: ScheduleWakeupParams): ScheduleWakeupIgnorableField[] {
	const ignored: ScheduleWakeupIgnorableField[] = [];
	if (params.delaySeconds !== undefined) ignored.push("delaySeconds");
	if (params.prompt !== undefined) ignored.push("prompt");
	return ignored;
}

async function executeStop(
	scheduler: ScheduleWakeupSchedulerPort,
	params: ScheduleWakeupParams,
): Promise<AgentToolResult<ScheduleWakeupDetails>> {
	if (params.noop !== undefined) throw new Error(NOOP_WITH_STOP_ERROR);
	const reason = requireReason(params.reason);
	const loopId = resolveDynamicLoopId(scheduler);
	const ignoredFields = collectIgnoredFields(params);
	const { endedAt } = await scheduler.stopDynamicLoop({ loopId, reason });
	return {
		content: [{ type: "text" as const, text: `Stopped dynamic loop ${loopId}.` }],
		details: {
			ok: true,
			action: "stopped",
			loopId,
			terminalReason: "stopped",
			reason,
			endedAt,
			ignoredFields,
		},
	};
}

async function executeSchedule(
	scheduler: ScheduleWakeupSchedulerPort,
	params: ScheduleWakeupParams,
): Promise<AgentToolResult<ScheduleWakeupDetails>> {
	const reason = requireReason(params.reason);
	const requestedDelaySeconds = params.delaySeconds;
	if (requestedDelaySeconds === undefined) throw new Error(MISSING_DELAY_ERROR);
	if (!Number.isInteger(requestedDelaySeconds)) throw new Error(NON_INTEGER_DELAY_ERROR);
	const prompt = params.prompt;
	if (prompt === undefined || prompt.trim().length === 0) throw new Error(MISSING_PROMPT_ERROR);

	const loopId = resolveDynamicLoopId(scheduler);
	const delaySeconds = clampDelaySeconds(requestedDelaySeconds);
	const clamped = delaySeconds !== requestedDelaySeconds;
	const noop = params.noop === true;

	const outcome = await scheduler.scheduleWakeup({
		loopId,
		requestedDelaySeconds,
		delaySeconds,
		reason,
		prompt,
		noop,
	});

	const text = clamped
		? `Scheduled loop ${loopId} in ${delaySeconds}s; requested ${requestedDelaySeconds}s was clamped to the supported ${MIN_WAKEUP_DELAY_SECONDS}-${MAX_WAKEUP_DELAY_SECONDS}s range.`
		: `Scheduled loop ${loopId} in ${delaySeconds}s.`;

	return {
		content: [{ type: "text" as const, text }],
		details: {
			ok: true,
			action: "scheduled",
			loopId,
			wakeupId: outcome.wakeupId,
			...(outcome.replacedWakeupId === undefined ? {} : { replacedWakeupId: outcome.replacedWakeupId }),
			requestedDelaySeconds,
			delaySeconds,
			clamped,
			dueAt: outcome.dueAt,
			reason,
			prompt,
			noop,
			noopStreak: outcome.noopStreak,
		},
	};
}

export function registerLoopTools(pi: ExtensionAPI, deps: LoopToolRegistrationDeps): void {
	pi.registerTool({
		name: SCHEDULE_WAKEUP_TOOL,
		label: "Schedule Wakeup",
		description: SCHEDULE_WAKEUP_DESCRIPTION,
		parameters: scheduleWakeupSchema,
		// Sequential so two concurrent model tool calls cannot race scheduler state.
		executionMode: "sequential",
		async execute(_toolCallId, params): Promise<AgentToolResult<ScheduleWakeupDetails>> {
			return params.stop === true ? executeStop(deps.scheduler, params) : executeSchedule(deps.scheduler, params);
		},
	});
}
