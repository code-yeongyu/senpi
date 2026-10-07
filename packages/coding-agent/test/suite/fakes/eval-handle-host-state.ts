import type { HandleError, HandleKind, HandleOutcome, HandlePhase, HandleRef } from "../../../src/index.ts";

/** One run of a fake host work item; a successor run gets its own state and the old one is never touched. */
export interface FakeEpochState {
	phase: HandlePhase;
	hostStatus: string;
	revision: number;
	value?: unknown;
	error?: HandleError;
	readonly transcript: string[];
	readonly cancelCalls: number[];
}

export interface FakeWork {
	readonly kind: HandleKind;
	readonly id: string;
	readonly ownerSessionId: string;
	liveEpoch: number;
	readonly epochs: Map<number, FakeEpochState>;
}

export interface FakeHostCall {
	readonly op: "watch" | "result" | "send" | "cancel" | "output";
	readonly refs: readonly HandleRef[];
	readonly ownerSessionId: string;
}

export function newEpoch(hostStatus: string): FakeEpochState {
	return { phase: "pending", hostStatus, revision: 1, transcript: [], cancelCalls: [] };
}

export function outcomeOf(ref: HandleRef, epoch: FakeEpochState): HandleOutcome {
	if (epoch.phase === "succeeded") return { status: "fulfilled", ref, value: epoch.value };
	return {
		status: "rejected",
		ref,
		error: epoch.error ?? { code: `eval_handle_${epoch.phase}`, message: `${ref.id} ${epoch.phase}` },
	};
}

export function refKey(ref: HandleRef): string {
	return `${ref.kind}:${ref.id}:${ref.run_epoch}`;
}

export function fakeHandleId(kind: HandleKind, sequence: number): string {
	const prefix = kind === "agent" ? "st_" : kind === "workpool" ? "wp_" : "cp_";
	return `${prefix}${sequence.toString(16).padStart(32, "0")}`;
}
