import type { AgentContinuationOptions } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { isProviderTimeoutError } from "@earendil-works/pi-ai/compat";

export interface ProviderTimeoutRetryPlan {
	options: AgentContinuationOptions;
	watchdogTimeoutMs: number | undefined;
}

export interface ProviderTimeoutRetryPlanInput {
	message: AssistantMessage;
	streamRetryTimeoutMs: number | undefined;
	timeoutMs: number | undefined;
	streamStartTimeoutMs: number | undefined;
}

export interface BoundedRetryContinuation {
	continueRun(): Promise<void>;
	getActiveSignal(): AbortSignal | undefined;
	abortActive(): void;
	timeoutMs: number | undefined;
}

export function createProviderTimeoutRetryPlan({
	message,
	streamRetryTimeoutMs,
	timeoutMs,
	streamStartTimeoutMs,
}: ProviderTimeoutRetryPlanInput): ProviderTimeoutRetryPlan {
	if (!isProviderTimeoutError(message)) {
		return { options: {}, watchdogTimeoutMs: undefined };
	}

	// The retry keeps the user's configured provider guards: shortening them
	// made a 90s stream-start budget expire after 30s, so a slow-but-alive
	// provider was reported as a second stall instead of being given the budget
	// it was configured with. `streamRetryTimeoutMs` still bounds the retry
	// continuation itself (see `runBoundedRetryContinuation`), which cancels a
	// wedged retry without lying to the provider about its deadline.
	return {
		options: {
			deferQueuedMessages: true,
			...(timeoutMs === undefined ? {} : { timeoutMs }),
			...(streamStartTimeoutMs === undefined ? {} : { streamStartTimeoutMs }),
		},
		watchdogTimeoutMs: streamRetryTimeoutMs,
	};
}

export async function runBoundedRetryContinuation({
	continueRun,
	getActiveSignal,
	abortActive,
	timeoutMs,
}: BoundedRetryContinuation): Promise<void> {
	const continuation = continueRun();
	const ownedSignal = getActiveSignal();
	if (timeoutMs === undefined || ownedSignal === undefined) {
		await continuation;
		return;
	}

	const timer = setTimeout(() => {
		if (getActiveSignal() === ownedSignal) {
			abortActive();
		}
	}, timeoutMs);
	try {
		await continuation;
	} finally {
		clearTimeout(timer);
	}
}
