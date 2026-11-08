// CK1s fixture: a StepCommitError built the way a second copy of @senpi/agent would build it (version
// skew, a bundler duplicate). It never imports the package, so `instanceof StepCommitError` is false
// for it while the registry brand still makes `isStepCommitError` true. CK1s injects this error
// through the reachable hosted commit boundary and asserts classification and containment.

const STEP_COMMIT_BRAND = Symbol.for("senpi.StepCommitError");

export type SecondCopyStepCommitFailure =
	| "already_committed"
	| "fenced"
	| "generation"
	| "epoch_unverified"
	| "storage_unavailable"
	| "ambiguous_unresolved";

export class SecondCopyStepCommitError extends Error {
	override readonly name = "StepCommitError" as const;
	readonly stepId: string;
	readonly code: SecondCopyStepCommitFailure;

	constructor(stepId: string, code: SecondCopyStepCommitFailure) {
		super(`step commit failed: ${code}`);
		this.stepId = stepId;
		this.code = code;
		Object.defineProperty(this, STEP_COMMIT_BRAND, { value: true, enumerable: false, writable: false });
	}
}
