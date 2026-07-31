import type { ExtensionContext, InputDispositionEvent, InputEvent } from "../../types.ts";
import { isMechanicalContinuationBlock } from "./continuation-recovery.ts";
import type { MonitorAwareGoalContinuation } from "./monitor-continuation.ts";
import { readGoal, resetContinuationStreak, updateGoal } from "./store.ts";
import type { Goal, GoalStoreRef } from "./types.ts";

type DirectInputCandidate = {
	readonly goalId: string | null;
};

type DirectInputLifecycleDependencies = {
	readonly monitor: MonitorAwareGoalContinuation;
	readonly goalStoreRef: (ctx: ExtensionContext) => GoalStoreRef;
	readonly beginAgentGoalAccounting: (goal: Goal) => void;
	readonly refreshGoalUi: (ctx: ExtensionContext, goal: Goal) => void;
};

/** Correlates raw input with admission before changing persisted Goal state. */
export class GoalDirectInputLifecycle {
	readonly #dependencies: DirectInputLifecycleDependencies;
	readonly #candidates = new Map<string, DirectInputCandidate>();

	constructor(dependencies: DirectInputLifecycleDependencies) {
		this.#dependencies = dependencies;
	}

	reset(): void {
		this.#candidates.clear();
	}

	async onInput(event: InputEvent, ctx: ExtensionContext): Promise<void> {
		if (event.source === "extension") return;

		this.#dependencies.monitor.holdDirectInput(event.inputId);
		this.#candidates.set(event.inputId, { goalId: null });
		const goal = await readGoal(this.#dependencies.goalStoreRef(ctx));
		this.#candidates.set(event.inputId, { goalId: goal?.id ?? null });
	}

	async onDisposition(event: InputDispositionEvent, ctx: ExtensionContext): Promise<void> {
		const candidate = this.#candidates.get(event.inputId);
		if (candidate === undefined) return;
		this.#candidates.delete(event.inputId);
		const accepted = event.disposition === "started" || event.disposition === "queued";
		this.#dependencies.monitor.resolveDirectInput(event.inputId, accepted);
		if (!accepted || candidate.goalId === null) return;

		const ref = this.#dependencies.goalStoreRef(ctx);
		const currentGoal = await readGoal(ref);
		if (currentGoal?.id !== candidate.goalId) return;

		if (currentGoal.status === "blocked" && isMechanicalContinuationBlock(currentGoal.blockedReason)) {
			await resetContinuationStreak(ref);
			const reactivated = await updateGoal(ref, { status: "active" }, "user");
			this.#dependencies.beginAgentGoalAccounting(reactivated);
			this.#dependencies.refreshGoalUi(ctx, reactivated);
			return;
		}

		if (currentGoal.status !== "active") return;
		const reset = await resetContinuationStreak(ref);
		if (reset !== null) this.#dependencies.refreshGoalUi(ctx, reset);
	}
}
