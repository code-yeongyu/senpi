import type { ChildProcess } from "node:child_process";
import type { AutomountRealpath, AutomountRealpathOptions } from "./automount-realpath.ts";

/** Resolver helpers alive at once; past it a path is answered unanswered without a spawn. */
const AUTOMOUNT_HELPER_LIMIT = 4;
/** How long an automount whose helper missed its deadline is answered unanswered without a new spawn. */
const AUTOMOUNT_UNANSWERED_FOR_MS = 300_000;

export interface AutomountHelperPoolOptions {
	readonly limit?: number;
	readonly unansweredForMs?: number;
	readonly now?: () => number;
}

/**
 * Bounds the resolver helpers (senpi#4565). A helper killed at its deadline may stay alive when its own lookup is
 * stuck in the kernel (a SIGKILL does not end a process waiting on an automounter that never answers), so a helper
 * counts as alive until its process really exits, concurrent requests for one path share one helper, and at most
 * `limit` are alive at once. An automount whose helper missed its deadline is answered unanswered for
 * `unansweredForMs` without a new spawn, so a watch re-armed every minute cannot pile up stuck helpers.
 */
export function createAutomountHelperPool(
	run: (path: string, options: AutomountRealpathOptions) => Promise<AutomountRealpath>,
	options: AutomountHelperPoolOptions = {},
): (path: string, key: string, resolve: AutomountRealpathOptions) => Promise<AutomountRealpath> {
	const limit = options.limit ?? AUTOMOUNT_HELPER_LIMIT;
	const unansweredForMs = options.unansweredForMs ?? AUTOMOUNT_UNANSWERED_FOR_MS;
	const now = options.now ?? Date.now;
	const inFlight = new Map<string, Promise<AutomountRealpath>>();
	const queued = new Map<string, Promise<unknown>>();
	const unansweredUntil = new Map<string, number>();
	let alive = 0;

	const start = (path: string, key: string, resolve: AutomountRealpathOptions): Promise<AutomountRealpath> => {
		const until = unansweredUntil.get(key);
		if (until !== undefined && now() < until)
			return Promise.resolve({ kind: "unanswered", reason: "recently_unanswered" });
		if (alive >= limit) return Promise.resolve({ kind: "unanswered", reason: "helper_limit" });
		alive += 1;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			alive -= 1;
		};
		const onSpawn = (child: ChildProcess) => {
			child.once("exit", release);
			child.once("error", release);
			resolve.onSpawn?.(child);
		};
		return run(path, { ...resolve, onSpawn }).then((settled) => {
			if (settled.kind === "unanswered") unansweredUntil.set(key, now() + unansweredForMs);
			else unansweredUntil.delete(key);
			return settled;
		});
	};

	return (path, key, resolve) => {
		const shared = inFlight.get(path);
		if (shared) return shared;
		// Paths under one automount wait for each other: one that did not answer then answers the next from the window,
		// so an unanswered automount never holds more than one helper.
		const answer = (queued.get(key) ?? Promise.resolve()).then(() => start(path, key, resolve));
		const tail = answer.catch(() => undefined);
		inFlight.set(path, answer);
		queued.set(key, tail);
		void tail.finally(() => {
			inFlight.delete(path);
			if (queued.get(key) === tail) queued.delete(key);
		});
		return answer;
	};
}
