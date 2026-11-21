import type { QueuedInputPort } from "./agent.ts";
import { isStepCommitError } from "./step-commit.ts";

/**
 * Errors raised by the owner's queued-input port (claim, release, commit) inside a run, and a hosted step commit that
 * failed after the provider answered. That code is local bookkeeping, never a provider request, so the run's failure
 * message is marked `failureSource: "local"` (senpi#3866): it is never retried as a provider failure, and the input
 * queued behind it is not started as after a provider error (senpi#6868).
 */
const localFailures = new WeakSet<object>();

export function isLocalFailure(error: unknown): boolean {
	return typeof error === "object" && error !== null && (localFailures.has(error) || isStepCommitError(error));
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
