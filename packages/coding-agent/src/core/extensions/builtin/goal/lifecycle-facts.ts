import type { AgentEndEvent } from "../../types.ts";
import type { TodoOwedOutcome } from "./todo-owed-backstop.ts";
import type { TurnEndLivenessInput } from "./turn-end-liveness.ts";
import type { Goal } from "./types.ts";

export interface GoalLifecycleFacts {
	readonly goal: Goal | null;
	readonly input?: TurnEndLivenessInput;
	/** What the todo backstop returned at the last turn end; a repeated `cap` emits no event. */
	readonly todoOutcome?: TodoOwedOutcome;
}

type Collector = (restoredEnd?: AgentEndEvent, goal?: Goal | null) => Promise<GoalLifecycleFacts>;
const collectors = new WeakMap<object, Collector>();
const observers = new WeakMap<object, (goal: Goal | null) => void>();

export function onGoalLifecycleChange(owner: object, listener: (goal: Goal | null) => void): () => void {
	observers.set(owner, listener);
	return () => {
		if (observers.get(owner) === listener) observers.delete(owner);
	};
}

/** Capture every transition synchronously; a later file reread may have missed a close. */
export function goalLifecycleChanged(owner: object, goal: Goal | null): void {
	observers.get(owner)?.(goal);
}

/** The goal builtin owns its timers/latches; lifecycle reads the same live collector. */
export function registerGoalLifecycleCollector(owner: object, collect: Collector): () => void {
	collectors.set(owner, collect);
	return () => {
		if (collectors.get(owner) === collect) collectors.delete(owner);
	};
}

export function collectGoalLifecycleFacts(
	owner: object,
	restoredEnd?: AgentEndEvent,
	goal?: Goal | null,
): Promise<GoalLifecycleFacts | undefined> {
	return collectors.get(owner)?.(restoredEnd, goal) ?? Promise.resolve(undefined);
}
