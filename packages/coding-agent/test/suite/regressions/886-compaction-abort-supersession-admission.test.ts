import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function seedOverThresholdSession(harness: Harness): void {
	const now = Date.now();
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "earlier prompt" }],
		timestamp: now - 3000,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("earlier response", { timestamp: now - 2000 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(9_800),
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("aborted admission compaction superseded by a newer claim (issue #886)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("admits the prompt instead of throwing RequiredCompactionError when a superseding compaction owns the route", async () => {
		let attempt = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event, ctx) => {
						attempt += 1;
						if (attempt > 1) return undefined;
						// The same supersession the production blocking route performs:
						// beginCompaction claims a fresh compaction controller, which
						// aborts this in-flight admission compaction and leaves a live
						// claimant owning the route.
						const aborted = new Promise<void>((resolve) => {
							event.signal.addEventListener("abort", () => resolve(), { once: true });
						});
						ctx.beginCompaction?.({ reason: "extension" });
						await aborted;
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		seedOverThresholdSession(harness);
		harness.setResponses([fauxAssistantMessage("answered next prompt")]);

		await expect(harness.session.prompt("next prompt")).resolves.toBeUndefined();

		expect(getUserTexts(harness)).toContain("next prompt");
		expect(attempt).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toContainEqual(
			expect.objectContaining({ reason: "pre_prompt" }),
		);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("still throws RequiredCompactionError when the failed compaction has no superseding claim", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({
						cancel: true,
						rejectionCause: "cancelled-by-extension",
						reason: "forced rejection",
					}));
				},
			],
		});
		harnesses.push(harness);
		seedOverThresholdSession(harness);
		harness.setResponses([fauxAssistantMessage("must not reach provider")]);

		await expect(harness.session.prompt("next prompt")).rejects.toThrow(
			"Context remains above the compaction threshold because compaction did not complete",
		);
		expect(harness.faux.state.callCount).toBe(0);
	});
});
