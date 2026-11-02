import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createProviderTimeoutRetryPlan } from "../src/core/provider-timeout-retry.ts";

const STREAM_START_TIMEOUT_MS = 90_000;
const IDLE_TIMEOUT_MS = 300_000;
const STREAM_RETRY_TIMEOUT_MS = 30_000;

function stallMessage() {
	return fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: `Provider stream start timed out after ${STREAM_START_TIMEOUT_MS}ms`,
	});
}

describe("provider timeout retry plan", () => {
	it("preserves the configured provider timeouts on the retry request", () => {
		const plan = createProviderTimeoutRetryPlan({
			message: stallMessage(),
			streamRetryTimeoutMs: STREAM_RETRY_TIMEOUT_MS,
			timeoutMs: IDLE_TIMEOUT_MS,
			streamStartTimeoutMs: STREAM_START_TIMEOUT_MS,
		});

		expect(plan.options).toMatchObject({
			deferQueuedMessages: true,
			timeoutMs: IDLE_TIMEOUT_MS,
			streamStartTimeoutMs: STREAM_START_TIMEOUT_MS,
		});
	});

	it("never cancels the retry before the stream-start budget it granted", () => {
		const plan = createProviderTimeoutRetryPlan({
			message: stallMessage(),
			streamRetryTimeoutMs: STREAM_RETRY_TIMEOUT_MS,
			timeoutMs: IDLE_TIMEOUT_MS,
			streamStartTimeoutMs: STREAM_START_TIMEOUT_MS,
		});

		// The continuation watchdog must outlast the guard the same retry was handed,
		// otherwise the retry is aborted on a deadline it was never given and the
		// bounded retry budget collapses to a single attempt.
		expect(plan.watchdogTimeoutMs).toBeGreaterThanOrEqual(STREAM_START_TIMEOUT_MS);
	});

	it("keeps a liveness cap that already outlasts the granted guards", () => {
		const generousCapMs = STREAM_START_TIMEOUT_MS * 2;
		const plan = createProviderTimeoutRetryPlan({
			message: stallMessage(),
			streamRetryTimeoutMs: generousCapMs,
			timeoutMs: IDLE_TIMEOUT_MS,
			streamStartTimeoutMs: STREAM_START_TIMEOUT_MS,
		});

		expect(plan.watchdogTimeoutMs).toBe(generousCapMs);
	});

	it("never re-enables a disabled provider guard", () => {
		const plan = createProviderTimeoutRetryPlan({
			message: stallMessage(),
			streamRetryTimeoutMs: STREAM_RETRY_TIMEOUT_MS,
			timeoutMs: undefined,
			streamStartTimeoutMs: undefined,
		});

		expect(plan.options).toEqual({ deferQueuedMessages: true });
		// With no provider guard to outlast, the configured cap is the only bound.
		expect(plan.watchdogTimeoutMs).toBe(STREAM_RETRY_TIMEOUT_MS);
	});

	it("reconciles the cap against a stream-start guard reported with no idle guard", () => {
		const plan = createProviderTimeoutRetryPlan({
			message: stallMessage(),
			streamRetryTimeoutMs: STREAM_RETRY_TIMEOUT_MS,
			timeoutMs: undefined,
			streamStartTimeoutMs: STREAM_START_TIMEOUT_MS,
		});

		expect(plan.watchdogTimeoutMs).toBeGreaterThan(STREAM_START_TIMEOUT_MS);
	});

	it("disables the cap when the operator disabled it, even with guards configured", () => {
		const plan = createProviderTimeoutRetryPlan({
			message: stallMessage(),
			streamRetryTimeoutMs: undefined,
			timeoutMs: IDLE_TIMEOUT_MS,
			streamStartTimeoutMs: STREAM_START_TIMEOUT_MS,
		});

		expect(plan.watchdogTimeoutMs).toBeUndefined();
	});

	it("keeps the zero opt-out disabled", () => {
		const plan = createProviderTimeoutRetryPlan({
			message: stallMessage(),
			streamRetryTimeoutMs: 0,
			timeoutMs: IDLE_TIMEOUT_MS,
			streamStartTimeoutMs: STREAM_START_TIMEOUT_MS,
		});
		expect(plan.watchdogTimeoutMs).toBeUndefined();
	});

	it("ignores messages that are not provider timeouts", () => {
		const plan = createProviderTimeoutRetryPlan({
			message: fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			streamRetryTimeoutMs: STREAM_RETRY_TIMEOUT_MS,
			timeoutMs: IDLE_TIMEOUT_MS,
			streamStartTimeoutMs: STREAM_START_TIMEOUT_MS,
		});

		expect(plan).toEqual({ options: {}, watchdogTimeoutMs: undefined });
	});
});
