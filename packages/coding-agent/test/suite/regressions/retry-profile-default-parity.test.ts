import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";
const third = "faux/faux-3";

describe("default retry parity (no declared profile)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("provider without a declared profile produces the exact pre-change call count and fallback chain", async () => {
		const maxRetries = 2;
		const chain = [fallback, third];
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries,
					baseDelayMs: 1,
					fallbackChains: { [primary]: chain },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses(
			Array.from({ length: 12 }, () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			),
		);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1 + (chain.length + 1) * maxRetries);
		expect(harness.eventsOfType("retry_fallback_applied").map((event) => event.to)).toEqual(chain);
		expect(harness.eventsOfType("retry_fallback_exhausted").map((event) => event.chainKey)).toEqual([primary]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([false]);
	});

	it("default delay sequence lands within [floor, floor * 1.25) for an unconfigured provider", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 2000,
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses(
			Array.from({ length: 5 }, () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			),
		);

		const promptPromise = harness.session.prompt("hello");

		const delays: number[] = [];
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") {
				delays.push(event.delayMs);
				if (delays.length >= 3) harness.session.abort();
			}
		});

		await promptPromise.catch(() => {});
		unsubscribe();

		expect(delays).toHaveLength(3);
		const floors = [2000, 4000, 8000];
		for (let i = 0; i < 3; i++) {
			const floor = floors[i]!;
			expect(delays[i]).toBeGreaterThanOrEqual(floor);
			expect(delays[i]).toBeLessThan(floor * 1.25);
		}
	});
});
