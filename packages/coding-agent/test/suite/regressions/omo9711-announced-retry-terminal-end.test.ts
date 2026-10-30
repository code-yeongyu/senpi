import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFallbackModels } from "../fallback-provider-fixture.ts";
import { createHarness, type Harness } from "../harness.ts";

// omo#9711: an RPC client settles a turn on the last agent_end whose willRetry is false. An end that
// announces a retry the engine then never starts leaves that client waiting until the account resets.
const accountLimit =
	'429 {"error":{"type":"rate_limit_error","message":"You have hit your session limit; resets 11pm"}}';

describe("omo#9711 an announced retry that never starts", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
		vi.useRealTimers();
	});

	it("ends with a terminal agent_end when every fallback rung shares the spent account", async () => {
		// given a chain whose only rung is on the provider the account limit just spent
		const harness = await createHarness({
			models: [{ id: "primary" }, { id: "sibling" }],
			settings: {
				compaction: { enabled: false },
				retry: {
					enabled: true,
					maxRetries: 5,
					baseDelayMs: 2000,
					fallbackChains: { "faux/primary": ["faux/sibling"] },
				},
			},
			fallbackNow: () => Date.now(),
			retryRandom: () => 0,
		});
		harnesses.push(harness);
		vi.useFakeTimers();
		harness.setResponses(
			Array.from({ length: 4 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: accountLimit })),
		);

		// when
		const turn = harness.session.prompt("continue");
		await vi.advanceTimersByTimeAsync(120_000);
		await turn;

		// then nothing ran after the limit, and the last end the session published says so
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["primary"]);
		const ends = harness.eventsOfType("agent_end");
		expect(ends.length).toBeGreaterThan(0);
		expect(ends.at(-1)?.willRetry).toBe(false);
		expect(harness.session.isStreaming).toBe(false);
	});

	it("still announces and runs the retry when a rung on another provider is usable", async () => {
		// given
		const harness = await createHarness({
			models: [{ id: "primary" }, { id: "sibling" }, { id: "spare" }],
			settings: {
				compaction: { enabled: false },
				retry: { enabled: true, fallbackChains: { "faux/primary": ["faux/sibling", "spare/spare"] } },
			},
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "spare", ["spare"]);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: accountLimit }),
			fauxAssistantMessage("answered by spare"),
		]);

		// when
		await harness.session.prompt("use my configured spare");

		// then
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["primary", "spare"]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
	});
});
