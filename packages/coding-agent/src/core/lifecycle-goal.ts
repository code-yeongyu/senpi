import { statSync } from "node:fs";
import { goalFilePath } from "./extensions/builtin/goal/persistence.ts";
import { readGoal } from "./extensions/builtin/goal/store.ts";
import type { Goal, GoalStoreRef } from "./extensions/builtin/goal/types.ts";

/** No-goal sessions must not wait for unrelated asynchronous filesystem work before admission. */
export function readLifecycleGoal(ref: GoalStoreRef): Promise<Goal | null> {
	try {
		statSync(goalFilePath(ref));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return Promise.resolve(null);
		throw error;
	}
	return readGoal(ref);
}
