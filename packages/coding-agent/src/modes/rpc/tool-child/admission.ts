import { TOOL_CHILD_LIMITS, type ToolChildMessageOf } from "./protocol.ts";

/**
 * The one host-call capacity both sides enforce: `HOST_CALL_ACTIVE` running plus `HOST_CALL_WAITING` queued (264).
 * The child admits against it before sending, the server admits against it on receipt; there is no second constant.
 */
export function hostCallCapacity(): number {
	return TOOL_CHILD_LIMITS.HOST_CALL_ACTIVE + TOOL_CHILD_LIMITS.HOST_CALL_WAITING;
}

export type HostCallRefusalCode = "host_call_capacity" | "host_call_duplicate";

export type HostCallDecision =
	| { state: "active" }
	| { state: "waiting" }
	| { state: "refused"; frame: ToolChildMessageOf<"host_call_refused"> };

/** Lossless host-call admission: a call is running, queued FIFO, or refused with a frame naming its `callId`. */
export class HostCallAdmission {
	readonly #active = new Set<string>();
	readonly #waiting: string[] = [];

	get active(): number {
		return this.#active.size;
	}

	get waiting(): number {
		return this.#waiting.length;
	}

	submit(callId: string): HostCallDecision {
		if (this.#active.has(callId) || this.#waiting.includes(callId)) return refuse(callId, "host_call_duplicate");
		if (this.#active.size < TOOL_CHILD_LIMITS.HOST_CALL_ACTIVE && this.#waiting.length === 0) {
			this.#active.add(callId);
			return { state: "active" };
		}
		if (this.#active.size + this.#waiting.length >= hostCallCapacity()) return refuse(callId, "host_call_capacity");
		this.#waiting.push(callId);
		return { state: "waiting" };
	}

	/** Ends a call (or withdraws a queued one) and returns the call promoted into the freed active slot, if any. */
	settle(callId: string): string | undefined {
		if (!this.#active.delete(callId)) {
			const index = this.#waiting.indexOf(callId);
			if (index >= 0) this.#waiting.splice(index, 1);
			return undefined;
		}
		const next = this.#waiting.shift();
		if (next !== undefined) this.#active.add(next);
		return next;
	}
}

function refuse(callId: string, code: HostCallRefusalCode): HostCallDecision {
	return { state: "refused", frame: { type: "host_call_refused", callId, code } };
}

export type JobRefusalCode =
	| "tool_child_jobs_full"
	| "tool_child_nested_full"
	| "tool_child_parent_unknown"
	| "tool_child_job_duplicate";

export type JobDecision = { admitted: true } | { admitted: false; frame: ToolChildMessageOf<"job_refused"> };

/**
 * Per-child job budget. Ordinary jobs are capped at `TOOL_CHILD_LIMITS.jobs`. A nested job (started on behalf of a
 * running job, e.g. a tool an eval cell calls) is admitted past that cap, so a full child cannot deadlock its own
 * callers; nested jobs arrive through host calls and are bounded by `hostCallCapacity()`.
 */
export class JobAdmission {
	readonly #ordinary = new Set<string>();
	readonly #nested = new Map<string, string>();

	admit(jobId: string, parentJobId?: string): JobDecision {
		if (this.#ordinary.has(jobId) || this.#nested.has(jobId)) return refuseJob(jobId, "tool_child_job_duplicate");
		if (parentJobId === undefined) {
			if (this.#ordinary.size >= TOOL_CHILD_LIMITS.jobs) return refuseJob(jobId, "tool_child_jobs_full");
			this.#ordinary.add(jobId);
			return { admitted: true };
		}
		if (!this.#ordinary.has(parentJobId) && !this.#nested.has(parentJobId)) {
			return refuseJob(jobId, "tool_child_parent_unknown");
		}
		if (this.#nested.size >= hostCallCapacity()) return refuseJob(jobId, "tool_child_nested_full");
		this.#nested.set(jobId, parentJobId);
		return { admitted: true };
	}

	finish(jobId: string): void {
		this.#ordinary.delete(jobId);
		this.#nested.delete(jobId);
	}
}

function refuseJob(jobId: string, code: JobRefusalCode): JobDecision {
	return { admitted: false, frame: { type: "job_refused", jobId, code } };
}
