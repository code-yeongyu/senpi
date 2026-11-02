import type { Storage } from "@earendil-works/pi-agent-core/experimental/pico3";

const WRITE_METHODS = new Set<PropertyKey>(["commit", "truncate"]);

/**
 * The micro session is written only through its storage's `commit` and `truncate`. Gating both on
 * the session lock means that once another process reclaims the lock, nothing in this process
 * (a run still streaming, an abort, a later close) can append to the session it now owns.
 */
export function lockGatedStorage<T extends Storage>(storage: T, assertHeld: () => void): T {
	return new Proxy(storage, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			if (!WRITE_METHODS.has(property)) return value.bind(target);
			return async (...args: unknown[]) => {
				assertHeld();
				return value.apply(target, args);
			};
		},
	});
}
