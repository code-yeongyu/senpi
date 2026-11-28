import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerRetryWatchdogAbortMessage } from "../src/core/agent-session.ts";
import { createProviderTimeoutRetryPlan, runBoundedRetryContinuation } from "../src/core/provider-timeout-retry.ts";

const STREAM_START_TIMEOUT_MS = 90_000;
const IDLE_TIMEOUT_MS = 300_000;
const STREAM_RETRY_TIMEOUT_MS = 30_000;

function stallMessage() {
	return fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: `Provider stream start timed out after ${STREAM_START_TIMEOUT_MS}ms (raise streamStartTimeoutMs: retry.provider.streamStartTimeoutMs in senpi settings; 0 disables)`,
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
	it("pins the enabled watchdog guidance", () => {
		expect(providerRetryWatchdogAbortMessage(12_345, 6_789)).toBe(
			"The retried request never started streaming after 12s. (Stream-start guard: 7s; to allow longer, raise retry.provider.streamStartTimeoutMs, 0 disables.)",
		);
	});

	it("pins the disabled stream-start watchdog guidance", () => {
		expect(providerRetryWatchdogAbortMessage(12_345, undefined)).toBe(
			"The retried request never started streaming after 12s. (Its stream-start guard is off; to bound or extend this wait, set retry.provider.streamStartTimeoutMs, 0 disables.)",
		);
	});
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

describe("bounded retry continuation with keep-alive bytes (#5018)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function keepAliveAttempt(
		keepAliveTimeoutMs: number | undefined,
		keepAliveEveryMs: number | undefined,
		respondsAfterMs: number,
	) {
		const controller = new AbortController();
		const listeners = new Set<() => void>();
		let aborted = false;
		let pings: ReturnType<typeof setInterval> | undefined;
		const continuation = runBoundedRetryContinuation({
			continueRun: () =>
				new Promise<void>((resolve) => {
					if (keepAliveEveryMs !== undefined)
						pings = setInterval(() => {
							for (const listener of listeners) listener();
						}, keepAliveEveryMs);
					setTimeout(() => {
						clearInterval(pings);
						resolve();
					}, respondsAfterMs);
					controller.signal.addEventListener("abort", () => {
						clearInterval(pings);
						resolve();
					});
				}),
			getActiveSignal: () => controller.signal,
			abortActive: () => {
				aborted = true;
				controller.abort();
			},
			timeoutMs: STREAM_RETRY_TIMEOUT_MS,
			keepAliveTimeoutMs,
			onTransportActivity: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		});
		return { continuation, aborted: () => aborted };
	}

	it("does not abort a retried request that keeps receiving keep-alives past the watchdog bound and then answers", async () => {
		const respondsAfterMs = STREAM_RETRY_TIMEOUT_MS * 4;
		const attempt = keepAliveAttempt(undefined, STREAM_RETRY_TIMEOUT_MS / 3, respondsAfterMs);
		await vi.advanceTimersByTimeAsync(respondsAfterMs + 1);
		await attempt.continuation;
		expect(attempt.aborted()).toBe(false);
	});

	it("still aborts a retried request that receives no bytes at the watchdog bound", async () => {
		const attempt = keepAliveAttempt(undefined, undefined, STREAM_RETRY_TIMEOUT_MS * 4);
		await vi.advanceTimersByTimeAsync(STREAM_RETRY_TIMEOUT_MS + 1);
		await attempt.continuation;
		expect(attempt.aborted()).toBe(true);
	});

	it("caps keep-alive-only silence at the keep-alive bound", async () => {
		const keepAliveTimeoutMs = STREAM_RETRY_TIMEOUT_MS * 2;
		const attempt = keepAliveAttempt(keepAliveTimeoutMs, STREAM_RETRY_TIMEOUT_MS / 3, STREAM_RETRY_TIMEOUT_MS * 10);
		await vi.advanceTimersByTimeAsync(keepAliveTimeoutMs + 1);
		await attempt.continuation;
		expect(attempt.aborted()).toBe(true);
	});
});
