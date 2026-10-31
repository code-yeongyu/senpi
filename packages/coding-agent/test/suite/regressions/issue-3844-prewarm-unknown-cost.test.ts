import type { ModelCost, WarmPromptCacheResult } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupPrewarmHarnesses, createPrewarmHarness, deferred, within } from "../prompt-cache-prewarm-harness.ts";

// senpi#3844: a prewarm on a model with no known price must not be recorded as a real $0.
const UNPRICED: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknown: true };

describe("prompt-cache prewarm on an unpriced model (#3844)", () => {
	afterEach(cleanupPrewarmHarnesses);

	it("#given a session model with no known price #when its prewarm reports usage without a cost #then the recorded usage and session stats carry costUnknown", async () => {
		// given
		const pendingWarm = deferred<WarmPromptCacheResult>();
		const { harness, warmCalled, entryAppended } = await createPrewarmHarness(() => pendingWarm.promise, {
			models: [{ id: "house-model", cost: UNPRICED }],
		});
		await harness.session.bindExtensions({});

		// when
		harness.session.recordUserActivity("draft");
		await within(warmCalled, "the prewarm request");
		pendingWarm.resolve({
			supported: true,
			usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 5169 },
			usageRaw: {},
		});
		const entry = await within(entryAppended, "the prewarm entry");

		// then
		expect(entry.data).toMatchObject({ phase: "warmed", usage: { cacheWrite: 5169, costUnknown: true } });
		expect(harness.session.getSessionStats().costUnknown).toBe(true);
	});
});
