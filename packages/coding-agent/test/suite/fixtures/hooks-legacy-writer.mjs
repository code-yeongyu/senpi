import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { workerData } from "node:worker_threads";
import lockfile from "proper-lockfile";

const { statePath, publishedState, phaseBuffer } = workerData;
const phase = new Int32Array(phaseBuffer);

if (Atomics.wait(phase, 0, 0, 5_000) === "timed-out") {
	throw new Error("Timed out waiting to start the legacy hooks-state writer");
}

const release = lockfile.lockSync(dirname(statePath), {
	realpath: false,
	lockfilePath: `${statePath}.lock`,
});

try {
	writeFileSync(statePath, "", "utf-8");
	Atomics.store(phase, 0, 2);
	Atomics.notify(phase, 0);
	if (Atomics.wait(phase, 0, 2, 5_000) === "timed-out") {
		throw new Error("Timed out waiting for the reader to capture truncated hooks state");
	}
	writeFileSync(statePath, publishedState, "utf-8");
} finally {
	release();
}

Atomics.store(phase, 0, 4);
Atomics.notify(phase, 0);
