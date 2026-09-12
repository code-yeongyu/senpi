import { installSessionWriteReservation } from "../../core/session-write-reservation.ts";
import { SESSION_WORKER_LIMITS, type SessionWorkerToHost, WORKER_CREDIT_CODES } from "./session-worker-protocol.ts";

/** Builds the host message around the wait signal it must carry. */
export type CreditRequest = (signal: SharedArrayBuffer) => SessionWorkerToHost;

export interface WorkerCredit {
	/** Blocks the worker until the host answers; a denial fails the worker with `deniedError`. */
	exchange(message: CreditRequest, deniedError?: string, signal?: SharedArrayBuffer): void;
	/** Installs the isolate's session-write grant, reporting denials as domain errors. */
	installWriteReservation(canonical: (path: string) => string): void;
}

/**
 * Synchronous host credit for a session worker.
 *
 * Every exchange blocks the worker thread on its own wait signal, so the host answers
 * before the worker touches a writer, publishes output, or resizes a display.
 */
export function createWorkerCredit(
	send: (message: SessionWorkerToHost) => void,
	fail: (error: string) => never,
): WorkerCredit {
	const request = (message: CreditRequest, signal: SharedArrayBuffer): number => {
		const state = new Int32Array(signal);
		send(message(signal));
		Atomics.wait(state, 0, 0, SESSION_WORKER_LIMITS.controlMs);
		return Atomics.load(state, 0);
	};
	return {
		exchange(message, deniedError = "session_worker_output_denied", signal = new SharedArrayBuffer(4)) {
			const result = request(message, signal);
			if (result === WORKER_CREDIT_CODES.conflict) fail(deniedError);
			if (result !== WORKER_CREDIT_CODES.granted) fail("session_worker_credit_timeout");
		},
		installWriteReservation(canonical) {
			installSessionWriteReservation((path) => {
				const result = request(
					(signal) => ({ type: "reserve", path: canonical(path), signal }),
					new SharedArrayBuffer(4),
				);
				// Both denials are session-level failures the caller reports, never worker-fatal:
				// another owner holds the path, or this worker's own budget is exhausted.
				if (result === WORKER_CREDIT_CODES.conflict) throw new Error("session_path_in_use");
				if (result === WORKER_CREDIT_CODES.limit) throw new Error("session_reservation_limit");
				if (result !== WORKER_CREDIT_CODES.granted) fail("session_worker_credit_timeout");
			});
		},
	};
}
