import { type SessionWriteGrant, WORKER_CREDIT_CODES } from "./session-worker-protocol.ts";

/** Releases a worker blocked in Atomics.wait with the host's decision. */
export function acknowledgeGrant(signal: SharedArrayBuffer, grant: SessionWriteGrant): void {
	const state = new Int32Array(signal);
	Atomics.store(state, 0, WORKER_CREDIT_CODES[grant]);
	Atomics.notify(state, 0);
}

export function acknowledge(signal: SharedArrayBuffer, granted: boolean): void {
	acknowledgeGrant(signal, granted ? "granted" : "conflict");
}
