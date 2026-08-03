/**
 * Canonical bounded-deadline helper for every senpi-qa script.
 *
 * Kept in its own file so common.mjs (already over the 250 pure-LOC ceiling)
 * does not grow, and so no second copy of the race-a-promise-against-a-timer
 * pattern drifts across probes and spikes.
 */

/** Race a promise against a bounded deadline (no polling, no fixed sleeps). */
export function withTimeout(promise, label, timeoutMs = 60_000) {
	let timer;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
