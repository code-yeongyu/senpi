import type { QueuedInputPort } from "./agent.ts";

/**
 * Local bookkeeping and observer failures inside a run, never provider failures.
 * Their failure messages are marked `failureSource: "local"` (senpi#3866, senpi#4054).
 */
const localFailures = new WeakSet<object>();

export function isLocalFailure(error: unknown): boolean {
	return typeof error === "object" && error !== null && localFailures.has(error);
}

export function markLocalFailure<T extends Error>(error: T): T {
	localFailures.add(error);
	return error;
}

async function local<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (typeof error === "object" && error !== null) localFailures.add(error);
		throw error;
	}
}

export function localFailurePort(port: QueuedInputPort): QueuedInputPort {
	return {
		claim: (queue, drain) => local(() => port.claim(queue, drain)),
		release: (queue, messages, giveBack) => local(() => port.release(queue, messages, giveBack)),
		commitConsumption: (queue, messages) => local(() => port.commitConsumption(queue, messages)),
	};
}
