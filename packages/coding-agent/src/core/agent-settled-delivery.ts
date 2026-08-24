export type DeferredTurnDisposition = "started" | "delegated" | "finished-without-start";

export class DeferredTurnClaim {
	readonly disposition: Promise<DeferredTurnDisposition>;
	#resolve: ((disposition: DeferredTurnDisposition) => void) | undefined;
	#onCancelled: (() => void) | undefined;

	constructor(onCancelled?: () => void) {
		this.#onCancelled = onCancelled;
		this.disposition = new Promise((resolve) => {
			this.#resolve = resolve;
		});
	}

	resolve(disposition: DeferredTurnDisposition): void {
		const resolve = this.#resolve;
		if (!resolve) return;
		this.#resolve = undefined;
		this.#onCancelled = undefined;
		resolve(disposition);
	}

	cancel(): void {
		if (!this.#resolve) return;
		const onCancelled = this.#onCancelled;
		this.#onCancelled = undefined;
		try {
			onCancelled?.();
		} finally {
			this.resolve("finished-without-start");
		}
	}
}

export type DeferredAgentSettledAction = () => void;

export interface DeferredAgentSettledBatch {
	actions: DeferredAgentSettledAction[];
	turnClaims: DeferredTurnClaim[];
}

export class AgentSettledDelivery {
	#generation: number | undefined;
	#actions: DeferredAgentSettledAction[] = [];
	#turnClaims: DeferredTurnClaim[] = [];

	begin(userAbortGeneration: number): void {
		this.#generation = userAbortGeneration;
		this.#actions = [];
		this.#turnClaims = [];
	}

	defer(action: DeferredAgentSettledAction): boolean {
		if (this.#generation === undefined) return false;
		this.#actions.push(action);
		return true;
	}

	deferTriggerTurn(action: (claim: DeferredTurnClaim) => void, onCancelled?: () => void): boolean {
		if (this.#generation === undefined) return false;
		const claim = new DeferredTurnClaim(onCancelled);
		this.#turnClaims.push(claim);
		this.#actions.push(() => action(claim));
		return true;
	}

	finish(userAbortGeneration: number): DeferredAgentSettledBatch {
		const generation = this.#generation;
		const actions = this.#actions;
		const turnClaims = this.#turnClaims;
		this.#generation = undefined;
		this.#actions = [];
		this.#turnClaims = [];
		const accepted = generation === userAbortGeneration;
		if (!accepted) {
			for (const claim of turnClaims) claim.cancel();
		}
		return accepted ? { actions, turnClaims } : { actions: [], turnClaims: [] };
	}

	cancel(): void {
		const turnClaims = this.#turnClaims;
		this.#generation = undefined;
		this.#actions = [];
		this.#turnClaims = [];
		for (const claim of turnClaims) claim.cancel();
	}
}
