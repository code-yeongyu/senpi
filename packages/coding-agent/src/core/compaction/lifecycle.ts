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
	readonly model?: CompactionModelRef;
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
	readonly model?: CompactionModelRef;
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

/**
 * Couples lifecycle reducer transitions with the controller that owns the
 * active generation. AgentSession owns event emission and durable work; this
 * coordinator only protects state transitions from stale callers.
 */
export class CompactionLifecycleCoordinator {
	private _state: CompactionLifecycleState = initialCompactionLifecycleState();
	private _controller: AbortController | undefined;

	get state(): CompactionLifecycleState {
		return this._state;
	}

	begin(operation: BeginCompactionOperation, controller: AbortController): string {
		if (this._state.status === "running") {
			if (this._controller === controller) {
				const runningOperationId = this._state.operationId;
				if (operation.stage === "execution") {
					this._state = promoteCompactionOperation(this._state, runningOperationId);
				}
				return runningOperationId;
			}
			this._controller?.abort();
		}

		this._controller = controller;
		this._state = beginCompactionOperation(this._state, operation);
		return operation.operationId;
	}

	isCurrent(operationId: string, controller: AbortController): boolean {
		return (
			this._state.status === "running" &&
			this._state.operationId === operationId &&
			this._controller === controller &&
			!controller.signal.aborted
		);
	}

	hasCurrentSignal(signal: AbortSignal): boolean {
		return this._state.status === "running" && this._controller?.signal === signal && !signal.aborted;
	}

	finish(event: FinishCompactionOperation): boolean {
		const next = finishCompactionOperation(this._state, event);
		if (next === this._state) return false;
		this._state = next;
		this._controller = undefined;
		return true;
	}

	abort(
		endedRevision: number,
	): { readonly reason: CompactionReason; readonly stage: "feedback" | "execution" } | undefined {
		if (this._state.status !== "running") return undefined;
		const { operationId, reason, stage } = this._state;
		this._controller?.abort();
		this.finish({
			operationId,
			status: "aborted",
			endedRevision,
			errorMessage: "Compaction cancelled",
		});
		return { reason, stage };
	}
}
