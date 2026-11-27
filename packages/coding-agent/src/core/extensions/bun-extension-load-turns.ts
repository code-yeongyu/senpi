/**
 * One extension module per event-loop turn (senpi#6199). Bun fetches the whole static graph of an `import()` inside
 * one microtask drain, so a synchronous `onLoad` holds the loop for every module of the graph: a host compiling an
 * extension (its boot load, a warm, an open) answered no socket until the last one. During an import each load waits
 * for its own turn instead; a synchronous `require()` cannot take a promise, so its loads still run at once.
 */
const queued: (() => void)[] = [];
let draining = false;
let synchronousDepth = 0;

function drainOne(): void {
	queued.shift()?.();
	if (queued.length > 0) setImmediate(drainOne);
	else draining = false;
}

export function loadInTurn<T>(load: () => T): T | Promise<T> {
	if (synchronousDepth > 0) return load();
	return new Promise<T>((resolve, reject) => {
		queued.push(() => {
			try {
				resolve(load());
			} catch (error) {
				reject(error);
			}
		});
		if (draining) return;
		draining = true;
		setImmediate(drainOne);
	});
}

/** Runs `require` so every module it loads is served synchronously, as a CommonJS require needs. */
export function loadSynchronously<T>(require: () => T): T {
	synchronousDepth++;
	try {
		return require();
	} finally {
		synchronousDepth--;
	}
}
