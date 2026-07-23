import type { CompactionReason, CompactionRejectionCause } from "../extensions/types.ts";

export interface CompactionModelRef {
	readonly provider: string;
	readonly id: string;
}

interface CompactionOperation {
	readonly generation: number;
	readonly operationId: string;
	readonly stage: "feedback" | "execution";
	readonly reason: CompactionReason;
	readonly model: CompactionModelRef;
	readonly startedRevision: number;
}

export type CompactionLifecycleState =
	| { readonly status: "idle"; readonly generation: 0 }
	| (CompactionOperation & { readonly status: "running" })
	| (CompactionOperation & {
			readonly status: "completed";
			readonly endedRevision: number;
	  })
	| (CompactionOperation & {
			readonly status: "failed";
			readonly endedRevision: number;
			readonly rejectionCause?: CompactionRejectionCause;
			readonly errorMessage?: string;
	  })
	| (CompactionOperation & {
			readonly status: "aborted";
			readonly endedRevision: number;
			readonly errorMessage?: string;
	  });

export interface BeginCompactionOperation {
	readonly operationId: string;
	readonly stage: "feedback" | "execution";
	readonly reason: CompactionReason;
	readonly model: CompactionModelRef;
	readonly startedRevision: number;
}

export interface FinishCompactionOperation {
	readonly operationId: string;
	readonly status: "completed" | "failed" | "aborted";
	readonly endedRevision: number;
	readonly rejectionCause?: CompactionRejectionCause;
	readonly errorMessage?: string;
}

export function initialCompactionLifecycleState(): CompactionLifecycleState {
	return { status: "idle", generation: 0 };
}

export function beginCompactionOperation(
	state: CompactionLifecycleState,
	operation: BeginCompactionOperation,
): CompactionLifecycleState {
	return {
		status: "running",
		generation: state.generation + 1,
		...operation,
	};
}

export function promoteCompactionOperation(
	state: CompactionLifecycleState,
	operationId: string,
): CompactionLifecycleState {
	if (state.status !== "running" || state.operationId !== operationId || state.stage === "execution") return state;
	return { ...state, stage: "execution" };
}

export function finishCompactionOperation(
	state: CompactionLifecycleState,
	event: FinishCompactionOperation,
): CompactionLifecycleState {
	if (state.status !== "running" || state.operationId !== event.operationId) return state;

	const operation: CompactionOperation = {
		generation: state.generation,
		operationId: state.operationId,
		stage: state.stage,
		reason: state.reason,
		model: state.model,
		startedRevision: state.startedRevision,
	};
	if (event.status === "completed") {
		return { ...operation, status: "completed", endedRevision: event.endedRevision };
	}
	if (event.status === "aborted") {
		return {
			...operation,
			status: "aborted",
			endedRevision: event.endedRevision,
			errorMessage: event.errorMessage,
		};
	}
	return {
		...operation,
		status: "failed",
		endedRevision: event.endedRevision,
		rejectionCause: event.rejectionCause,
		errorMessage: event.errorMessage,
	};
}
