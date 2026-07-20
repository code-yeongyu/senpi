import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SelectorCooldowns } from "../../src/core/retry-fallback/cooldown.ts";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";
const insufficientQuota = "billing error: insufficient_quota";

type RetryFallbackInternals = {
	_retryFallback?: { deps?: { cooldowns?: SelectorCooldowns } };
};

function cooldownsFor(harness: Harness): SelectorCooldowns {
	const cooldowns = (harness.session as unknown as RetryFallbackInternals)._retryFallback?.deps?.cooldowns;
	if (!cooldowns) throw new Error("Expected retry fallback cooldowns");
	return cooldowns;
}

describe("retry fallback hard errors", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("switches immediately after an insufficient-quota error and suppresses the failed selector", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, maxRetries: 0, baseDelayMs: 60_000, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: insufficientQuota }),
			fauxAssistantMessage("fallback answer"),
		]);

		await harness.session.prompt("hello");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
		expect(
			harness.events
				.filter(
					(event) =>
						event.type === "retry_fallback_applied" ||
						event.type === "auto_retry_start" ||
						event.type === "retry_fallback_succeeded",
				)
				.map((event) => {
					if (event.type === "retry_fallback_applied") return `${event.type}:${event.reason}`;
					if (event.type === "auto_retry_start") return `${event.type}:${event.delayMs}`;
					return event.type;
				}),
		).toEqual(["retry_fallback_applied:hard-error", "auto_retry_start:0", "retry_fallback_succeeded"]);
		expect(cooldownsFor(harness).isSuppressed(primary)).toBe(true);
	});

	it("settles an insufficient-quota error without a configured fallback", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: insufficientQuota })]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.session.state.messages.at(-1)).toMatchObject({ errorMessage: insufficientQuota });
	});

	it("does not replay a hard error that contains a tool call", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("unsafe", {})], {
				stopReason: "error",
				errorMessage: insufficientQuota,
			}),
		]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
	});

	it("does not treat context overflow as a hard-error fallback", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "Error Code context_too_large: Your input exceeds the context window of this model.",
			}),
		]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
	});

	it("does not treat an aborted response as a hard-error fallback", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request aborted by user." }),
		]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
	});
});
