/**
 * A steer that names the turn it is meant for (senpi#5776). The name is checked at the moment the steer enters the
 * runtime's queue, in the same synchronous step, so a turn that ends while the steer waits on input handlers, command
 * holds or the pending-input journal can never receive it.
 */
export class TurnConflictError extends Error {
	/** The running turn when the steer was refused; undefined when no turn was running. */
	readonly currentTurnId: string | undefined;

	constructor(currentTurnId: string | undefined) {
		super(
			currentTurnId === undefined
				? "No turn is running, so this steer cannot reach the turn it names."
				: `This steer names a turn that is not running; the running turn is ${currentTurnId}.`,
		);
		this.name = "TurnConflictError";
		this.currentTurnId = currentTurnId;
	}
}

/** The refusal for a steer meant for `expected` while `current` runs; undefined when it may be queued. */
export function turnConflict(expected: string | undefined, current: string | undefined): TurnConflictError | undefined {
	if (expected === undefined || expected === current) return undefined;
	return new TurnConflictError(current);
}
