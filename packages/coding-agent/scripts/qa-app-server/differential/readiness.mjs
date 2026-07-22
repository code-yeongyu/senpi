import { setTimeout as waitForBackoff } from "node:timers/promises";
import { httpStatus } from "./driver.mjs";

const INITIAL_BACKOFF_MS = 10;
const MAX_BACKOFF_MS = 250;
const PROBE_TIMEOUT_MS = 1000;

export class ReadinessError extends Error {
	name = "ReadinessError";
}

export async function waitForHttpReady({ server, port, path = "/readyz", deadlineMs = 30000 }) {
	const controller = new AbortController();
	const deadlineError = new ReadinessError(`${server.label} readiness timed out.`);
	const deadline = setTimeout(() => controller.abort(deadlineError), deadlineMs);
	const childExit = server.closed.then((result) => {
		const error = new ReadinessError(`${server.label} exited before readiness (${describeExit(result)}).`);
		controller.abort(error);
		throw error;
	});
	try {
		await Promise.race([probeUntilReady({ port, path, signal: controller.signal }), childExit]);
	} finally {
		clearTimeout(deadline);
		controller.abort(new ReadinessError(`${server.label} readiness completed.`));
	}
}

async function probeUntilReady({ port, path, signal }) {
	let backoffMs = INITIAL_BACKOFF_MS;
	while (true) {
		throwIfAborted(signal);
		try {
			if ((await httpStatus({ port, path, timeoutMs: PROBE_TIMEOUT_MS, signal })) === 200) return;
		} catch (error) {
			if (signal.aborted) throw abortReason(signal);
			if (!(error instanceof Error)) throw error;
		}
		await waitForBackoff(backoffMs, undefined, { signal }).catch((error) => {
			if (signal.aborted) throw abortReason(signal);
			throw error;
		});
		backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
	}
}

function throwIfAborted(signal) {
	if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal) {
	return signal.reason instanceof Error ? signal.reason : new ReadinessError("Readiness wait was aborted.");
}

function describeExit(result) {
	if (result.error instanceof Error) return result.error.message;
	return `code=${String(result.code)} signal=${String(result.signal)}`;
}
