import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("#1873 fallback rung repair", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function createChainHarness(compactionEnabled: boolean): Promise<Harness> {
		const harness = await createHarness({
			models: [
				{ id: "primary", contextWindow: 100_000, maxTokens: 64 },
				{ id: "smaller", contextWindow: 60_000, maxTokens: 64 },
			],
			settings: {
				compaction: compactionEnabled ? { enabled: true, keepRecentTokens: 1 } : { enabled: false },
				retry: {
					enabled: true,
					maxRetries: 0,
					fallbackChains: { "faux/primary": ["faux/smaller"] },
				},
			},
		});
		// Several turns, not one block: the slice cuts at entry boundaries, so a
		// transcript has to have boundaries for it to reduce anything.
		for (let turn = 0; turn < 12; turn++) {
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `turn ${turn} ${"long context ".repeat(1_700)}` }],
				timestamp: turn * 2 + 1,
			});
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage(`reply ${turn}`, { timestamp: turn * 2 + 2 }),
				api: harness.getModel().api,
				provider: harness.getModel().provider,
				model: "primary",
			});
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
			fauxAssistantMessage("answered after the fallback"),
		]);
		return harness;
	}

	it("reduces the transcript so a context-incompatible rung can take the turn", async () => {
		// given a chain whose only rung cannot hold the live transcript
		const harness = await createChainHarness(true);
		harnesses.push(harness);

		// when the primary fails and the chain advances
		await harness.session.prompt("recover");

		// then the rung was repaired and used rather than rejected
		expect(harness.session.model?.id).toBe("smaller");
		expect(harness.eventsOfType("retry_fallback_applied")).toHaveLength(1);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toContain("smaller");
		// The repair itself has to be observable, or this case could pass without it.
		expect(harness.eventsOfType("resume_context_reduced")).toHaveLength(1);
	});

	it("refuses a rung when a single oversized turn leaves the slice nothing to cut", async () => {
		// given one block of context with no interior boundary
		const harness = await createHarness({
			models: [
				{ id: "primary", contextWindow: 100_000, maxTokens: 64 },
				{ id: "smaller", contextWindow: 60_000, maxTokens: 64 },
			],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1 },
				retry: { enabled: true, maxRetries: 0, fallbackChains: { "faux/primary": ["faux/smaller"] } },
			},
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "long context ".repeat(20_000) }],
			timestamp: 1,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
		]);

		// when the primary fails
		await harness.session.prompt("recover");

		// then no reduction is possible without a provider request, so the rung stands refused
		expect(harness.session.model?.id).toBe("primary");
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
	});

	it("still rejects the rung when the session may not reduce its transcript", async () => {
		// given the same chain with compaction turned off
		const harness = await createChainHarness(false);
		harnesses.push(harness);

		// when the primary fails
		await harness.session.prompt("recover");

		// then nothing may shrink the context, so the rung stays refused
		expect(harness.session.model?.id).toBe("primary");
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
	});
});
