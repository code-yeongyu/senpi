import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderTimeoutRetryPlan, runBoundedRetryContinuation } from "../src/core/provider-timeout-retry.ts";

const STREAM_START_TIMEOUT_MS = 90_000;
const IDLE_TIMEOUT_MS = 300_000;
const STREAM_RETRY_TIMEOUT_MS = 30_000;

function stallMessage() {
	return fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: `Provider stream start timed out after ${STREAM_START_TIMEOUT_MS}ms`,
	});
}

/**
 * Drives one retry continuation whose provider answers after `respondsAfterMs`,
 * using the watchdog the plan actually produced. Returns whether the watchdog
 * aborted the attempt before the provider answered.
 */
async function runRetryAttempt(watchdogTimeoutMs: number | undefined, respondsAfterMs: number) {
	const controller = new AbortController();
	let aborted = false;

	const continuation = runBoundedRetryContinuation({
		continueRun: () =>
			new Promise<void>((resolve) => {
				setTimeout(resolve, respondsAfterMs);
			}),
		getActiveSignal: () => controller.signal,
		abortActive: () => {
			aborted = true;
			controller.abort();
		},
		timeoutMs: watchdogTimeoutMs,
	});

	await vi.advanceTimersByTimeAsync(Math.max(respondsAfterMs, watchdogTimeoutMs ?? 0) + 1);
	await continuation;
	return aborted;
}

describe("bounded retry continuation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("lets a slow-but-alive provider answer inside the stream-start budget it was granted", async () => {
		const plan = createProviderTimeoutRetryPlan({
			message: stallMessage(),
			streamRetryTimeoutMs: STREAM_RETRY_TIMEOUT_MS,
			timeoutMs: IDLE_TIMEOUT_MS,
			streamStartTimeoutMs: STREAM_START_TIMEOUT_MS,
		});

		// The provider answers at 60s: past the 30s liveness cap, but well inside
		// the 90s stream-start budget this same retry was handed. Aborting here is
		// what collapsed the bounded retry budget into "Aborted after 1 retry
		// attempt" — the attempt was killed on a deadline it was never given.
		const aborted = await runRetryAttempt(plan.watchdogTimeoutMs, 60_000);

		expect(aborted).toBe(false);
	});

	it("still cancels a retry that outlives every guard it was granted", async () => {
		const plan = createProviderTimeoutRetryPlan({
			message: stallMessage(),
			streamRetryTimeoutMs: STREAM_RETRY_TIMEOUT_MS,
			timeoutMs: IDLE_TIMEOUT_MS,
			streamStartTimeoutMs: STREAM_START_TIMEOUT_MS,
		});

		// A wedged retry that blows past the granted stream-start budget is still
		// cancelled: the reconciliation raises the cap, it never removes it.
		const aborted = await runRetryAttempt(plan.watchdogTimeoutMs, STREAM_START_TIMEOUT_MS * 3);

		expect(aborted).toBe(true);
	});

	it("does not arm a watchdog when the operator disabled the liveness cap", async () => {
		const plan = createProviderTimeoutRetryPlan({
			message: stallMessage(),
			streamRetryTimeoutMs: undefined,
			timeoutMs: IDLE_TIMEOUT_MS,
			streamStartTimeoutMs: STREAM_START_TIMEOUT_MS,
		});

		const aborted = await runRetryAttempt(plan.watchdogTimeoutMs, STREAM_START_TIMEOUT_MS * 3);

		expect(aborted).toBe(false);
	});
});
