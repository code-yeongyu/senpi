import { parentPort, workerData } from "node:worker_threads";
import { WorkerPermitGate } from "../../../src/modes/rpc/session-worker-permits.ts";

/**
 * A real isolate on one permit block: it asks for a permit, and "builds a payload" (counts one) only once a permit is
 * held, then reports the typed outcome. The isolate is otherwise idle, so it exits as soon as it has answered.
 */
const { block, timeoutMs, window } = workerData as {
	block: SharedArrayBuffer;
	timeoutMs: number;
	window?: SharedArrayBuffer;
};
if (window) holdFirstWait(block, window);
const outcome = new WorkerPermitGate(block, timeoutMs).acquire();
const built = outcome === "granted" ? 1 : 0;
parentPort?.postMessage({ outcome, built });

/**
 * #5591: holds the gate's first `Atomics.wait` on `block` at the call, after the gate made every check that decided to
 * wait and before the wait itself runs. The isolate says so on `window` (word 0 -> 1) and resumes into the real wait
 * only once the host writes 2, so a host signal lands in exactly that window, whatever the scheduling.
 */
function holdFirstWait(block: SharedArrayBuffer, window: SharedArrayBuffer): void {
	type Int32Wait = (
		array: Int32Array,
		index: number,
		value: number,
		timeout?: number,
	) => ReturnType<typeof Atomics.wait>;
	const word = new Int32Array(window);
	const wait: Int32Wait = Atomics.wait;
	let held = false;
	const holding: Int32Wait = (array, index, value, timeout) => {
		if (!held && array.buffer === block) {
			held = true;
			Atomics.store(word, 0, 1);
			Atomics.notify(word, 0);
			wait(word, 0, 1);
		}
		return wait(array, index, value, timeout);
	};
	// The gate waits only on its Int32 permit block, so the Int32 overload is the whole surface it calls.
	Atomics.wait = holding as typeof Atomics.wait;
}
