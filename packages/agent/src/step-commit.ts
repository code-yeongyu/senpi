/**
 * The durable step commit a hosted brain host installs through `AgentLoopConfig.commitStep`.
 *
 * Fused and split-local assemblies never set `commitStep` and never construct a `StepCommitError`;
 * only a hosted host's commit implementation (and its conformance harness) does. The error is branded
 * with a registry symbol so a value built by a second copy of this package (version skew, a bundler
 * duplicate) is still recognised: callers check it with `isStepCommitError`, never `instanceof`.
 */

export type StepCommitFailure =
	| "already_committed"
	| "fenced"
	| "generation"
	| "epoch_unverified"
	| "storage_unavailable"
	| "ambiguous_unresolved";

const STEP_COMMIT_BRAND: unique symbol = Symbol.for("senpi.StepCommitError");

/** A hosted step commit failed; the step's message is not durable and must not be acted on. */
export class StepCommitError extends Error {
	override readonly name = "StepCommitError" as const;
	declare readonly [STEP_COMMIT_BRAND]: true;
	readonly stepId: string;
	readonly code: StepCommitFailure;

	constructor(stepId: string, code: StepCommitFailure, options?: { readonly cause?: unknown }) {
		super(`step commit failed: ${code}`, options);
		this.stepId = stepId;
		this.code = code;
		Object.defineProperty(this, STEP_COMMIT_BRAND, { value: true, enumerable: false, writable: false });
	}
}

/** True for a `StepCommitError` from any copy of this package; false for look-alikes without the brand. */
export function isStepCommitError(value: unknown): value is StepCommitError {
	return typeof value === "object" && value !== null && Reflect.get(value, STEP_COMMIT_BRAND) === true;
}
