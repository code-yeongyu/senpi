import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import lockfile from "proper-lockfile";

const { statePath, publishedState, phaseBuffer } = workerData;
const phase = new Int32Array(phaseBuffer);
const PHASE_FAILED = -1;

// Blocks until the shared phase moves away from `from`. Each wait is conditioned on the
// value just read, so a notify that lands between the load and the wait is never lost.
function waitForPhaseChange(from) {
	let current = Atomics.load(phase, 0);
	while (current === from) {
		Atomics.wait(phase, 0, from);
		current = Atomics.load(phase, 0);
	}
	return current;
}

try {
	parentPort.postMessage("ready");
	const started = waitForPhaseChange(0);
	if (started !== 1) {
		throw new Error(`Expected the reader to request the writer (phase 1), got phase ${started}`);
	}

	const release = lockfile.lockSync(dirname(statePath), {
		realpath: false,
		lockfilePath: `${statePath}.lock`,
	});

	try {
		writeFileSync(statePath, "", "utf-8");
		Atomics.store(phase, 0, 2);
		Atomics.notify(phase, 0);
		const captured = waitForPhaseChange(2);
		if (captured !== 3) {
			throw new Error(`Expected the reader to capture truncated hooks state (phase 3), got phase ${captured}`);
		}
		writeFileSync(statePath, publishedState, "utf-8");
	} finally {
		release();
	}

	Atomics.store(phase, 0, 4);
	Atomics.notify(phase, 0);
} catch (error) {
	Atomics.store(phase, 0, PHASE_FAILED);
	Atomics.notify(phase, 0);
	throw error;
}
