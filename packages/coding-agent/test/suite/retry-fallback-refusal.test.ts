import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";
const nextFallback = "faux/faux-3";

function refusal(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage(text, {
		stopReason: "error",
		errorMessage: "misleading_success_output",
		stopDetails: { type: "refusal" },
	});
}

function fallbackState(harness: Harness): { pinned: boolean } | undefined {
	return (
		harness.session as unknown as {
			_retryFallback: { activeState: { pinned: boolean } | undefined };
		}
	)._retryFallback.activeState;
}

describe("retry fallback classifier refusals", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("pins a configured fallback and retries it immediately after a classifier refusal", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([refusal("primary refusal"), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, reason: "refusal" },
		]);
		expect(harness.eventsOfType("auto_retry_start")).toMatchObject([{ delayMs: 0 }]);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
		expect(fallbackState(harness)?.pinned).toBe(true);

		harness.setResponses([fauxAssistantMessage("second prompt")]);
		await harness.session.prompt("stale state must remain pinned");
		expect(harness.faux.getCallLog()[2]?.modelId).toBe("faux-2");
	});

	it("settles a refusal without a chain without consuming retry budget", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([refusal("visible final refusal")]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.session.retryAttempt).toBe(0);
		expect(harness.session.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			errorMessage: "misleading_success_output",
		});
	});

	it("does not use an over-budget fallback switch for a refusal", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, maxRetries: 0, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([refusal("budget exhausted refusal")]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.session.retryAttempt).toBe(0);
	});

	it("walks a refusal from a fallback to the next candidate while pinned", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
			settings: {
				retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback, nextFallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			refusal("primary refusal"),
			refusal("fallback refusal"),
			fauxAssistantMessage("next answer"),
		]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, reason: "refusal" },
			{ from: fallback, to: nextFallback, reason: "refusal" },
		]);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2", "faux-3"]);
		expect(fallbackState(harness)?.pinned).toBe(true);
	});

	it("keeps only the final refusal active when every chain candidate refuses", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
			settings: {
				retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback, nextFallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([refusal("first refusal"), refusal("second refusal"), refusal("final refusal")]);

		await harness.session.prompt("hello");

		const activeRefusals = harness.session.state.messages.filter(
			(message) => message.role === "assistant" && message.stopDetails?.type === "refusal",
		);
		const historyRefusals = harness.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.stopDetails?.type === "refusal",
			);
		expect(activeRefusals).toHaveLength(1);
		expect(activeRefusals[0]).toMatchObject({ errorMessage: "misleading_success_output" });
		expect(historyRefusals).toHaveLength(3);
		expect(harness.eventsOfType("retry_fallback_exhausted")).toMatchObject([{ chainKey: primary }]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([0, 0]);
	});
});
