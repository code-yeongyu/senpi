export type DeferredAgentSettledAction = () => void;

export class AgentSettledDelivery {
	#generation: number | undefined;
	#actions: DeferredAgentSettledAction[] = [];

	begin(userAbortGeneration: number): void {
		this.#generation = userAbortGeneration;
		this.#actions = [];
	}

	defer(action: DeferredAgentSettledAction): boolean {
		if (this.#generation === undefined) return false;
		this.#actions.push(action);
		return true;
	}

	finish(userAbortGeneration: number): DeferredAgentSettledAction[] {
		const actions = this.#generation === userAbortGeneration ? this.#actions : [];
		this.#generation = undefined;
		this.#actions = [];
		return actions;
	}

	cancel(): void {
		this.#generation = undefined;
		this.#actions = [];
	}
}
