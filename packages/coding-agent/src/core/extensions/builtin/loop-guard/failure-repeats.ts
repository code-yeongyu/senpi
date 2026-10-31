import { FAILED_REPEAT_STOP_THRESHOLD, FAILED_REPEAT_WARNING_THRESHOLD } from "./policy.ts";
import type { ToolCallRecord } from "./tracker.ts";

export interface FailedRepeatDetection {
	readonly kind: "failed";
	readonly toolName: string;
	readonly count: number;
}

export type FailedRepeatDecision =
	| { readonly kind: "none" }
	| { readonly kind: "warn"; readonly detection: FailedRepeatDetection }
	| {
			readonly kind: "stop";
			readonly toolName: string;
			readonly failedCallCount: number;
			readonly announce: boolean;
	  };

interface FailedRun {
	readonly signature: string;
	readonly toolName: string;
	count: number;
	stopAnnounced: boolean;
}

const NO_DECISION = { kind: "none" } as const;

/**
 * Counts consecutive identical calls (same tool + canonical args) whose results were errors.
 * A successful result or a failure of a different call ends the run.
 */
export class FailedRepeatTracker {
	private readonly attempts = new Map<string, ToolCallRecord>();
	private run: FailedRun | undefined;

	observeStart(toolCallId: string, record: ToolCallRecord): void {
		this.attempts.set(toolCallId, record);
	}

	observeEnd(toolCallId: string, isError: boolean): FailedRepeatDecision {
		const record = this.attempts.get(toolCallId);
		this.attempts.delete(toolCallId);
		if (record === undefined) return NO_DECISION;
		if (!isError) {
			this.run = undefined;
			return NO_DECISION;
		}
		if (this.run === undefined || this.run.signature !== record.signature) {
			this.run = { signature: record.signature, toolName: record.toolName, count: 0, stopAnnounced: false };
		}
		this.run.count++;
		if (this.run.count >= FAILED_REPEAT_STOP_THRESHOLD) {
			const announce = !this.run.stopAnnounced;
			this.run.stopAnnounced = true;
			return { kind: "stop", toolName: this.run.toolName, failedCallCount: this.run.count, announce };
		}
		if (this.run.count === FAILED_REPEAT_WARNING_THRESHOLD) {
			return { kind: "warn", detection: { kind: "failed", toolName: this.run.toolName, count: this.run.count } };
		}
		return NO_DECISION;
	}

	finishTurn(): void {
		this.attempts.clear();
	}

	reset(): void {
		this.attempts.clear();
		this.run = undefined;
	}
}
