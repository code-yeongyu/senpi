import type { TodoOwedOutcome } from "./extensions/builtin/goal/todo-owed-backstop.ts";
import type { TurnEndLivenessInput } from "./extensions/builtin/goal/turn-end-liveness.ts";
import type { LifecycleStop } from "./session-lifecycle-types.ts";
import type { TurnDeadlineKind } from "./turn-deadline.ts";
import { isRecord } from "./work-custody-record.ts";

/** Stop facts the stopping run produced itself, read from that run's own end (senpi#3864). */
export interface RunStopFacts {
	/** The run the turn end belonged to when its agent_end was emitted. */
	readonly runId?: string;
	readonly guard?: { readonly reason: string; readonly at: number };
	readonly todo?: TodoOwedOutcome;
}

/** A deadline captured when it fired, before its durable write, for the run it stopped. */
export interface DeadlineStopCapture {
	readonly runId: string;
	readonly kind: TurnDeadlineKind;
	readonly at: string;
	readonly persisted?: false;
}

type StopDetail = Omit<LifecycleStop, "runId" | "epoch" | "at"> & { readonly at?: string };

const ABORT_SOURCES: Partial<Record<TurnEndLivenessInput["endedBy"], LifecycleStop["abortSource"] | null>> = {
	"user-abort": "user",
	"system-abort": "system",
	"provider-abort": "provider",
	"unknown-abort": null,
};

/**
 * First match wins: the run's own deadline explains its system abort, a guard explains a refused continuation, then
 * the classified abort, and `no_wake` only for a stall no hold or guard owns. Provider failures keep the failed path.
 */
export function stopDetail(
	input: TurnEndLivenessInput | undefined,
	facts: RunStopFacts | undefined,
	deadline: DeadlineStopCapture | undefined,
	stalled: boolean,
): StopDetail | undefined {
	if (input?.endedBy === "provider-error" || input?.endedBy === "policy-rejection") return undefined;
	if (deadline)
		return {
			cause: "deadline",
			deadline: deadline.kind,
			at: deadline.at,
			...(deadline.persisted === false ? { persisted: false as const } : {}),
		};
	if (facts?.guard)
		return { cause: "goal_guard", guard: facts.guard.reason, at: new Date(facts.guard.at).toISOString() };
	if (facts?.todo === "capped" || facts?.todo === "cap") return { cause: "todo_guard", todo: "cap" };
	const abortSource = input ? ABORT_SOURCES[input.endedBy] : undefined;
	if (abortSource !== undefined) return { cause: "aborted", ...(abortSource === null ? {} : { abortSource }) };
	if (stalled && !input?.deadlineStop && !input?.budgetSpent) return { cause: "no_wake" };
	return undefined;
}

export function sameStop(stop: LifecycleStop, detail: StopDetail): boolean {
	return (
		stop.cause === detail.cause &&
		stop.deadline === detail.deadline &&
		stop.guard === detail.guard &&
		stop.todo === detail.todo &&
		stop.abortSource === detail.abortSource &&
		stop.persisted === detail.persisted
	);
}

/** The latest guard appended within one bound end's extension-processing window, including legacy entries. */
export function goalGuardAfter(
	branch: readonly {
		readonly id: string;
		readonly type: string;
		readonly customType?: string;
		readonly data?: unknown;
	}[],
	guardStartLeafId: string | null,
): RunStopFacts["guard"] {
	const start = guardStartLeafId === null ? -1 : branch.findIndex((entry) => entry.id === guardStartLeafId);
	if (guardStartLeafId !== null && start < 0) return undefined;
	for (let index = branch.length - 1; index > start; index--) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== "goal-continuation-stopped" || !isRecord(entry.data))
			continue;
		const { reason, at } = entry.data;
		return typeof reason === "string" && typeof at === "number" ? { reason, at } : undefined;
	}
	return undefined;
}

/** Malformed optional detail is dropped; it never invalidates the record that carries it. */
export function readLastStop(value: unknown, runId: unknown): LifecycleStop | undefined {
	if (
		!isRecord(value) ||
		typeof value.runId !== "string" ||
		value.runId !== runId ||
		typeof value.at !== "string" ||
		typeof value.epoch !== "number"
	)
		return undefined;
	const base = { runId: value.runId, at: value.at, epoch: value.epoch };
	switch (value.cause) {
		case "deadline":
			return value.deadline === "inactivity" || value.deadline === "max_runtime"
				? {
						...base,
						cause: value.cause,
						deadline: value.deadline,
						...(value.persisted === false ? { persisted: false as const } : {}),
					}
				: undefined;
		case "goal_guard":
			return { ...base, cause: value.cause, ...(typeof value.guard === "string" ? { guard: value.guard } : {}) };
		case "todo_guard":
			return { ...base, cause: value.cause, todo: "cap" };
		case "aborted":
			return {
				...base,
				cause: value.cause,
				...(value.abortSource === "user" || value.abortSource === "system" || value.abortSource === "provider"
					? { abortSource: value.abortSource }
					: {}),
			};
		case "no_wake":
			return { ...base, cause: value.cause };
		default:
			return undefined;
	}
}
