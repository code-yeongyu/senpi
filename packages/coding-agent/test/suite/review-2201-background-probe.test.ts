import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { createHarness } from "./harness.ts";

it("does not overlap an in-flight probe-back with a foreground probe from the same session", async () => {
	let now = 0;
	const harness = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }],
		fallbackNow: () => now,
		settings: {
			retry: {
				enabled: true,
				maxRetries: 0,
				baseDelayMs: 0,
				hintedWaitCapMs: 1000,
				fallbackChains: { "faux/faux-1": ["faux/faux-2"] },
			},
		},
	});
	const scheduled = new Map<number, () => void>();
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const realSetTimeout = globalThis.setTimeout;
	vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, delay, ...args) => {
		if (delay === 30_000 || delay === 60_000) {
			scheduled.set(delay, () => handler(...args));
			return realSetTimeout(() => {}, 0);
		}
		return realSetTimeout(handler, delay, ...args);
	});
	harness.setResponses([
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "HTTP 429: rate_limit_error (retry-after-ms: 60000)",
		}),
		fauxAssistantMessage("fallback"),
		async () => {
			started.resolve();
			await finish.promise;
			return fauxAssistantMessage("background probe finished");
		},
		fauxAssistantMessage("foreground answer"),
	]);
	try {
		await harness.session.prompt("schedule probe-back");
		const deadline = scheduled.get(60_000);
		if (!deadline) throw new Error("deadline probe timer missing");
		now = 60_001;
		deadline();
		await started.promise;
		await harness.session.prompt("foreground while background probe is live");
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2", "faux-1", "faux-2"]);
	} finally {
		finish.resolve();
		harness.cleanup();
		vi.restoreAllMocks();
	}
});
