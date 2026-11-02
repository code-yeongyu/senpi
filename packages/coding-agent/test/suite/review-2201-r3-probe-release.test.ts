import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { fallbackCircuitsFor } from "../../src/core/retry-fallback/circuit.ts";
import { createHarness } from "./harness.ts";

it.each(["success", "error", "aborted", "throw"] as const)(
	"releases a background lane after %s settlement",
	async (outcome) => {
		let now = 0;
		const h = await createHarness({
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
		const timers = new Map<number, () => void>();
		const realSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, delay, ...args) => {
			if (delay === 30_000 || delay === 60_000) {
				timers.set(delay, () => handler(...args));
				return realSetTimeout(() => {}, 0);
			}
			return realSetTimeout(handler, delay, ...args);
		});
		const completion = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
		const started = Promise.withResolvers<void>();
		try {
			h.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "HTTP 429: rate_limit_error (retry-after-ms: 60000)",
				}),
				fauxAssistantMessage("fallback"),
			]);
			await h.session.prompt("schedule a background recovery request");
			vi.spyOn(h.session.modelRuntime, "completeSimple").mockImplementation(async () => {
				started.resolve();
				return completion.promise;
			});
			const settled = new Promise<void>((resolve) => {
				const unsubscribe = h.session.subscribe((event) => {
					if (event.type === "retry_probe_result") {
						unsubscribe();
						resolve();
					}
				});
			});
			const run = timers.get(60_000);
			if (!run) throw new Error("missing deadline probe");
			now = 60_001;
			run();
			await started.promise;
			const breaker = fallbackCircuitsFor(join(h.tempDir, "agent"));
			expect(breaker.isOpen("faux/faux-1", now, "other:turn")).toBe(true);
			switch (outcome) {
				case "success":
					completion.resolve(fauxAssistantMessage("OK"));
					break;
				case "error":
					completion.resolve(fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 503" }));
					break;
				case "aborted":
					completion.resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
					break;
				case "throw":
					completion.reject(new Error("transport failed"));
					break;
				default: {
					const exhaustive: never = outcome;
					throw new Error(`unexpected outcome ${exhaustive}`);
				}
			}
			await settled;
			now += 120_001;
			expect(breaker.admit("faux/faux-1", now, "other:turn").kind).not.toBe("open");
			breaker.releaseOwnersWithPrefix("other:");
		} finally {
			completion.resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
			h.cleanup();
			vi.restoreAllMocks();
		}
	},
);
