/**
 * The `activity`, `error_code` and `turn_id` a `list_sessions` row carries (N3), derived from the same runtime view,
 * the same fanout view (`SessionStatusStream.fanoutView`, whose pending-question count `session_status` also reads)
 * and the same live status a `session_status` row is derived from, so the two never disagree. A caller that passes
 * no fanout view lets the runtime's own count decide.
 *
 * | live status (`session_status.status`) | runtime                      | activity            |
 * |---------------------------------------|------------------------------|---------------------|
 * | `waiting_input`                       | any                          | `awaiting_approval` |
 * | `running` or `compacting`             | a steer or follow-up pending | `queued`            |
 * | `running` or `compacting`             | nothing pending              | `running`           |
 * | `idle`                                | the last turn failed         | `errored`           |
 * | `idle`                                | otherwise                    | `idle`              |
 *
 * A session with no runtime yet (opening) is `idle`.
 */
import { liveStatus, type SessionStatusFanoutView, type SessionStatusRuntimeView } from "./session-status.ts";

export type SessionActivity = "idle" | "running" | "awaiting_approval" | "queued" | "errored";

export interface SessionActivityFields {
	readonly activity: SessionActivity;
	/** The last turn's failure category (`agent_end.failure.category`); present only with `errored`. */
	readonly error_code?: string;
	/** The current turn's id, or the most recent one's; absent before this runtime's first turn. */
	readonly turn_id?: string;
}

export function deriveSessionActivity(
	runtime: SessionStatusRuntimeView | undefined,
	fanout: SessionStatusFanoutView = { pendingQuestions: undefined },
): SessionActivityFields {
	if (runtime === undefined) return { activity: "idle" };
	const activity = activityOf(runtime, fanout);
	return {
		activity,
		...(activity === "errored" && runtime.errorCode !== undefined ? { error_code: runtime.errorCode } : {}),
		...(runtime.turnId !== undefined ? { turn_id: runtime.turnId } : {}),
	};
}

function activityOf(runtime: SessionStatusRuntimeView, fanout: SessionStatusFanoutView): SessionActivity {
	const status = liveStatus(runtime, fanout);
	switch (status) {
		case "waiting_input":
			return "awaiting_approval";
		case "running":
		case "compacting":
			return runtime.steering + runtime.followUp > 0 ? "queued" : "running";
		case "idle":
			return runtime.errorCode !== undefined ? "errored" : "idle";
		default: {
			const exhaustive: never = status;
			throw new Error(`unexpected live status ${String(exhaustive)}`);
		}
	}
}
