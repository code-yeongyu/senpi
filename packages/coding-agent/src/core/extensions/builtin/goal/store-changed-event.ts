import type { ExtensionContext } from "../../types.ts";

export const GOAL_STORE_CHANGED_EVENT = "goal_store_changed";

export interface GoalStoreChangedEvent {
	readonly threadId: string;
	readonly ctx?: ExtensionContext;
}

export function isGoalStoreChangedEvent(data: unknown): data is GoalStoreChangedEvent {
	return (
		typeof data === "object" &&
		data !== null &&
		"threadId" in data &&
		typeof data.threadId === "string" &&
		data.threadId.length > 0
	);
}
