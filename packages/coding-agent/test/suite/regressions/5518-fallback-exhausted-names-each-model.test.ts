import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// senpi#5518: when every rung of the session's chain fails, the turn ends with one typed failure that
// names each model tried and why, not just the last rung's error.
const crashed = fauxAssistantMessage("", {
	stopReason: "error",
	errorMessage: "Claude Code process exited with code 1",
});
const spent = fauxAssistantMessage("", {
	stopReason: "error",
	errorMessage:
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
});

describe("senpi#5518: an exhausted fallback chain fails typed", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("emits retry_fallback_exhausted listing every model tried with its reason", async () => {
		const harness = await createHarness({
			provider: "anthropic-subscription",
			models: [{ id: "claude-opus-5-5" }, { id: "claude-opus-5" }],
			settings: { retry: { enabled: true, maxRetries: 0, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([crashed, spent]);

		await harness.session.prompt("hi");

		expect(harness.eventsOfType("retry_fallback_exhausted")).toEqual([
			{
				type: "retry_fallback_exhausted",
				chainKey: "anthropic-subscription/claude-opus-5-5",
				// The wording of lastError for a credit-balance refusal is the engine's own label (part of senpi#5518, separate PR).
				lastError: expect.any(String),
				attempts: [
					{ model: "anthropic-subscription/claude-opus-5-5", reason: "error", error: crashed.errorMessage },
					{ model: "anthropic-subscription/claude-opus-5", reason: "out_of_credit", error: spent.errorMessage },
				],
			},
		]);
		const [end] = harness.eventsOfType("auto_retry_end");
		expect(end?.success).toBe(false);
		expect(end?.finalError).toContain("anthropic-subscription/claude-opus-5-5: error");
		expect(end?.finalError).toContain("anthropic-subscription/claude-opus-5: out of credit");
	});

	it("emits nothing extra for a single-model turn with no chain", async () => {
		const harness = await createHarness({
			provider: "faux",
			models: [{ id: "faux-1" }],
			settings: { retry: { enabled: true, maxRetries: 0, baseDelayMs: 1, modelFallback: false } },
		});
		harnesses.push(harness);
		harness.setResponses([crashed]);

		await harness.session.prompt("hi");

		expect(harness.eventsOfType("retry_fallback_exhausted")).toEqual([]);
	});
});
