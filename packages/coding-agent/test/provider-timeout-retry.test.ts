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

	it("bounds the retry continuation with the liveness cap without shortening provider guards", () => {
		const plan = createProviderTimeoutRetryPlan({
			message: stallMessage(),
			streamRetryTimeoutMs: STREAM_RETRY_TIMEOUT_MS,
			timeoutMs: IDLE_TIMEOUT_MS,
			streamStartTimeoutMs: STREAM_START_TIMEOUT_MS,
		});

		expect(plan.watchdogTimeoutMs).toBe(STREAM_RETRY_TIMEOUT_MS);
	});

	it("never re-enables a disabled provider guard", () => {
		const plan = createProviderTimeoutRetryPlan({
			message: stallMessage(),
			streamRetryTimeoutMs: STREAM_RETRY_TIMEOUT_MS,
			timeoutMs: undefined,
			streamStartTimeoutMs: undefined,
		});

		expect(plan.options).toEqual({ deferQueuedMessages: true });
		expect(plan.watchdogTimeoutMs).toBe(STREAM_RETRY_TIMEOUT_MS);
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
