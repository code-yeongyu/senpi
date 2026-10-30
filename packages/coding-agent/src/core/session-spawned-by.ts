import type { SpawnedBy } from "./session-lifecycle-types.ts";

/** The shared CLI / open_session boundary contract; IDs are opaque, non-empty strings. */
export function isSpawnedBy(value: unknown): value is SpawnedBy {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"parentSessionId" in value &&
		typeof value.parentSessionId === "string" &&
		value.parentSessionId.length > 0 &&
		"rootSessionId" in value &&
		typeof value.rootSessionId === "string" &&
		value.rootSessionId.length > 0 &&
		"taskId" in value &&
		typeof value.taskId === "string" &&
		value.taskId.length > 0
	);
}
