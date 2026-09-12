export type DeferredTurnDisposition = "started" | "delegated" | "finished-without-start";

export class DeferredTurnClaim {
	readonly disposition: Promise<DeferredTurnDisposition>;
	#resolve: ((disposition: DeferredTurnDisposition) => void) | undefined;

	constructor() {
		this.disposition = new Promise((resolve) => {
			this.#resolve = resolve;
		});
	}

	resolve(disposition: DeferredTurnDisposition): void {
		const resolve = this.#resolve;
		if (!resolve) return;
		this.#resolve = undefined;
		resolve(disposition);
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

	deferTriggerTurn(action: (claim: DeferredTurnClaim) => void): boolean {
		if (this.#generation === undefined) return false;
		const claim = new DeferredTurnClaim();
		this.#turnClaims.push(claim);
		this.#actions.push(() => action(claim));
		return true;
	}

	finish(userAbortGeneration: number): DeferredAgentSettledBatch {
		const batch =
			this.#generation === userAbortGeneration
				? { actions: this.#actions, turnClaims: this.#turnClaims }
				: { actions: [], turnClaims: [] };
		this.#generation = undefined;
		this.#actions = [];
		this.#turnClaims = [];
		return batch;
	}

	cancel(): void {
		for (const claim of this.#turnClaims) claim.resolve("finished-without-start");
		this.#generation = undefined;
		this.#actions = [];
		this.#turnClaims = [];
	}
}
