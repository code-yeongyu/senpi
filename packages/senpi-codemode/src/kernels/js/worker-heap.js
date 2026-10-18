import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

// Bun 1.4.3 ships its own idle collections (oven-sh/bun#43174, #43681), run by every JS thread including
// Workers; the kernel's idle collection only fills that gap on older Bun and must not compete with it.
const BUN_WITHOUT_IDLE_COLLECTIONS = "<1.4.3";

/**
 * Reads and collects this worker's own heap (a worker thread owns its VM on both runtimes).
 *
 * Bun: `heapStats()` refreshes only at collections and walks the whole heap, and `Bun.gc(false)` only
 * requests an asynchronous collection, so the estimate runs a synchronous eden collection (`edenGC()`, a
 * few ms) that accounts fresh ArrayBuffers, then reads `heapSize()` (it includes `extraMemorySize`). Node: the isolate's used heap plus external memory (ArrayBuffer backing stores); `Worker`
 * rejects `--expose-gc` in `execArgv`, so the gc function comes from one new context created while the
 * flag is briefly on, and the second call releases backing stores V8 frees one cycle late.
 */
export function createHeapProbe() {
	const jsc = typeof globalThis.Bun?.gc === "function" ? process.getBuiltinModule?.("bun:jsc") : undefined;
	if (jsc !== undefined && typeof jsc.heapSize === "function" && typeof jsc.edenGC === "function") {
		return {
			canCollect: true,
			idleCollection: globalThis.Bun.semver.satisfies(globalThis.Bun.version, BUN_WITHOUT_IDLE_COLLECTIONS),
			estimate() {
				jsc.edenGC();
				return jsc.heapSize();
			},
			collect() {
				globalThis.Bun.gc(true);
				return jsc.heapSize();
			},
		};
	}
	const gc = exposedGc();
	const read = () => {
		const stats = getHeapStatistics();
		return stats.used_heap_size + (stats.external_memory ?? 0);
	};
	return {
		canCollect: gc !== undefined,
		idleCollection: gc !== undefined,
		estimate: read,
		collect() {
			gc?.();
			gc?.();
			return read();
		},
	};
}

function exposedGc() {
	if (typeof globalThis.gc === "function") return globalThis.gc;
	setFlagsFromString("--expose-gc");
	try {
		const gc = runInNewContext("typeof gc === 'function' ? gc : undefined");
		return typeof gc === "function" ? gc : undefined;
	} finally {
		setFlagsFromString("--no-expose-gc");
	}
}
