import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

const overloaded = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });

describe("retry fallback revert-to-primary", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("(a) reverts at the next prompt after the primary cooldown expires", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			overloaded(),
			fauxAssistantMessage("fallback answer"),
			fauxAssistantMessage("primary answer"),
		]);

		await harness.session.prompt("first");
		expect(harness.session.model?.id).toBe("faux-2");

		now += 10 * 60_000; // past overloaded cooldown (45s + <=30s jitter)
		await harness.session.prompt("second");

		const reverted = harness.eventsOfType("retry_fallback_reverted");
		expect(reverted).toHaveLength(1);
		expect(reverted[0]).toMatchObject({ from: fallback, to: primary });
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.faux.getCallLog()[2]?.modelId).toBe("faux-1");
	});

	it("(b) reverts between the retry sleep and the continuation when suppression expires mid-backoff", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: { enabled: true, baseDelayMs: 200, maxRetries: 3, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([overloaded(), overloaded(), fauxAssistantMessage("primary recovered")]);
		// The second error exhausts chain candidates, so the retry sleeps with real
		// backoff; advancing the clock during that sleep expires the primary cooldown.
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && event.delayMs > 0) now += 10 * 60_000;
		});

		await harness.session.prompt("flaky twice");

		const reverted = harness.eventsOfType("retry_fallback_reverted");
		expect(reverted).toHaveLength(1);
		expect(reverted[0]).toMatchObject({ from: fallback, to: primary });
		const callLog = harness.faux.getCallLog();
		expect(callLog).toHaveLength(3);
		expect(callLog[2]?.modelId).toBe("faux-1");
	});

	it("(c) never auto-reverts a pinned refusal fallback", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "Stream ended with refusal",
				stopDetails: { type: "refusal" },
			}),
			fauxAssistantMessage("fallback answer"),
			fauxAssistantMessage("fallback again"),
		]);

		await harness.session.prompt("touchy");
		expect(harness.session.model?.id).toBe("faux-2");

		now += 60 * 60_000;
		await harness.session.prompt("second");

		expect(harness.eventsOfType("retry_fallback_reverted")).toHaveLength(0);
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.faux.getCallLog()[2]?.modelId).toBe("faux-2");
	});

	it('(d) never auto-reverts when revertPolicy is "never"', async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: {
					enabled: true,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback] },
					fallbackRevertPolicy: "never",
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			overloaded(),
			fauxAssistantMessage("fallback answer"),
			fauxAssistantMessage("fallback again"),
		]);

		await harness.session.prompt("first");
		expect(harness.session.model?.id).toBe("faux-2");

		now += 10 * 60_000;
		await harness.session.prompt("second");

		expect(harness.eventsOfType("retry_fallback_reverted")).toHaveLength(0);
		expect(harness.session.model?.id).toBe("faux-2");
	});

	it("(e) preserves a user thinking-level override through the revert", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: true },
			],
			fallbackNow: () => now,
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			overloaded(),
			fauxAssistantMessage("fallback answer"),
			fauxAssistantMessage("primary answer"),
		]);

		await harness.session.prompt("first");
		expect(harness.session.model?.id).toBe("faux-2");
		harness.session.setThinkingLevel("high");
		expect(harness.session.thinkingLevel).toBe("high");

		now += 10 * 60_000;
		await harness.session.prompt("second");

		expect(harness.eventsOfType("retry_fallback_reverted")).toHaveLength(1);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("(f) manual setModel during an active fallback clears state and aborts the pending retry", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: { enabled: true, baseDelayMs: 200, maxRetries: 3, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([overloaded(), overloaded(), fauxAssistantMessage("should never be requested")]);
		let switched = false;
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && event.delayMs > 0 && !switched) {
				switched = true;
				const manual = harness.getModel("faux-1");
				if (!manual) throw new Error("missing faux-1");
				void harness.session.setModel(manual);
			}
		});

		await harness.session.prompt("flaky then manual");

		// The manual change aborted the pending fallback retry sleep and cleared
		// fallback state: no third provider call, no later surprise revert.
		expect(harness.faux.getCallLog()).toHaveLength(2);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.eventsOfType("retry_fallback_reverted")).toHaveLength(0);
		now += 10 * 60_000;
		harness.setResponses([fauxAssistantMessage("after manual")]);
		await harness.session.prompt("after manual");
		expect(harness.eventsOfType("retry_fallback_reverted")).toHaveLength(0);
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("(g) delivers queued steering on the next turn regardless of the active model", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: { enabled: true, baseDelayMs: 200, maxRetries: 3, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([overloaded(), overloaded(), fauxAssistantMessage("recovered with steering")]);
		let steered = false;
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && event.delayMs > 0 && !steered) {
				steered = true;
				void harness.session.steer("steer note");
				now += 10 * 60_000;
			}
		});

		await harness.session.prompt("flaky with steering");

		const finalRequest = harness.faux.getCallLog()[2];
		if (!finalRequest) throw new Error("missing final provider request");
		const serialized = JSON.stringify(finalRequest.context.messages);
		expect(serialized).toContain("steer note");
	});

	it("(h) overflow on the fallback model triggers neither fallback nor revert", async () => {
		const now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			overloaded(),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long: 200000 tokens > 100000 maximum",
			}),
		]);

		await harness.session.prompt("overflowing");

		expect(harness.eventsOfType("retry_fallback_applied")).toHaveLength(1);
		expect(harness.eventsOfType("retry_fallback_reverted")).toHaveLength(0);
		expect(harness.session.model?.id).toBe("faux-2");
	});
});
