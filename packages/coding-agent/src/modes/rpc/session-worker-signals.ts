import { type SessionWriteGrant, WORKER_CREDIT_CODES, type WorkerDisplay } from "./session-worker-protocol.ts";

/** Releases a worker blocked in Atomics.wait with the host's decision. */
export function acknowledgeGrant(signal: SharedArrayBuffer, grant: SessionWriteGrant): void {
	const state = new Int32Array(signal);
	Atomics.store(state, 0, WORKER_CREDIT_CODES[grant]);
	Atomics.notify(state, 0);
}

export function acknowledge(signal: SharedArrayBuffer, granted: boolean): void {
	acknowledgeGrant(signal, granted ? "granted" : "conflict");
}

/** Publishes the host's current width and revision into a display exchange, then releases it. */
export function respondDisplay(signal: SharedArrayBuffer, display: WorkerDisplay): void {
	const values = new Float64Array(signal);
	values[1] = display.width;
	values[2] = display.revision;
	Atomics.store(new Int32Array(signal), 1, display.rendered ? 1 : 0);
	acknowledge(signal, true);
}
