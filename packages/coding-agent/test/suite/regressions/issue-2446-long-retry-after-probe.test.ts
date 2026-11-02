import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CIRCUIT_MAX_COOLDOWN_MS, fallbackCircuitsFor } from "../../../src/core/retry-fallback/circuit.ts";
import { createHarness, type Harness } from "../harness.ts";

// The senpi#2446 incident: a gateway answered one 429 with a stale ~23.7 h wait, and the
// client refused the entry for the whole hint although the upstream had already recovered.
const staleGatewayWaitMs = 85_370_000;
const rateLimited = (retryAfterMs: number) =>
	fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: `429 event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"All tokens rate limited"}} (retry-after-ms: ${retryAfterMs})`,
	});
const answer = (text: string) => fauxAssistantMessage(text);
const primary = "faux/faux-1";
const pastCeiling = DEFAULT_CIRCUIT_MAX_COOLDOWN_MS + 1;

describe("issue 2446: a retry-after longer than the circuit ceiling is re-checked once the ceiling elapses", () => {
	const harnesses: Harness[] = [];
	let now = 0;

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		now = 0;
	});

	async function session(): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: { enabled: true, maxRetries: 0, baseDelayMs: 1, fallbackChains: { [primary]: ["faux/faux-2"] } },
			},
		});
		harnesses.push(harness);
		return harness;
	}

	const calledModels = (harness: Harness) => harness.faux.getCallLog().map((call) => call.modelId);
	const breaker = (harness: Harness) => fallbackCircuitsFor(join(harness.tempDir, "agent"));

	it("admits the recovered model again after 30 minutes and closes the circuit when it answers", async () => {
		const harness = await session();
		harness.setResponses([rateLimited(staleGatewayWaitMs), answer("fallback"), answer("primary is back")]);

		await harness.session.prompt("the gateway replays a 23.7 hour wait");
		expect(calledModels(harness)).toEqual(["faux-1", "faux-2"]);

		now += pastCeiling;
		await harness.session.prompt("half an hour later");

		expect({
			calls: calledModels(harness),
			model: harness.session.model?.id,
			open: breaker(harness).isOpen(primary, now, "sibling"),
		}).toEqual({ calls: ["faux-1", "faux-2", "faux-1"], model: "faux-1", open: false });
	});

	it("re-opens with the fresh hint when the probe is rate limited again", async () => {
		const harness = await session();
		harness.setResponses([
			rateLimited(staleGatewayWaitMs),
			answer("fallback"),
			rateLimited(staleGatewayWaitMs - pastCeiling),
			answer("fallback again"),
		]);

		await harness.session.prompt("the gateway replays a 23.7 hour wait");
		now += pastCeiling;
		await harness.session.prompt("the limit is real this time");

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2", "faux-1", "faux-2"]);
		expect(breaker(harness).admit(primary, now + DEFAULT_CIRCUIT_MAX_COOLDOWN_MS - 1, "sibling").kind).toBe("open");
		expect(breaker(harness).admit(primary, now + pastCeiling, "sibling").kind).toBe("probe");
	});
});
