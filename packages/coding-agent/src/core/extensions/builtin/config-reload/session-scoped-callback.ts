import { activeProviderScope, bindToProviderScope } from "@earendil-works/pi-ai/node/provider-scope";

/**
 * Bind a watcher or timer callback to the session's provider scope.
 *
 * Outside a scope (classic single-session mode) the callback is returned as is. Inside a
 * scope the callback runs in that scope for as long as the session is alive, and is a
 * no-op once the scope has closed: a filesystem event or debounce timer can fire after
 * its session was torn down, and a dead session has nothing left to reload. Throwing
 * "Provider scope is closed" out of a timer nobody awaits is what leaked those watchers
 * on the shared host (senpi#1905).
 */
export function bindSessionScopedCallback<TArgs extends unknown[]>(
	callback: (...args: TArgs) => void,
): (...args: TArgs) => void {
	const scope = activeProviderScope();
	if (scope === undefined) return callback;
	const bound = bindToProviderScope(callback);
	return (...args) => {
		if (scope.state === "closed") return;
		bound(...args);
	};
}
