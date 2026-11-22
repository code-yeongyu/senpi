import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import btwExtension from "../../../src/core/extensions/builtin/btw/index.ts";
import lookAtExtension from "../../../src/core/extensions/builtin/look-at/index.ts";
import { captureSdkRequests, cleanupSdkPaths, sdkPathHarness } from "./2848-sdk-cwd-fixture.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=";

afterEach(() => {
	cleanupSdkPaths();
	vi.restoreAllMocks();
});

describe("senpi#2848 SDK side requests", () => {
	it("passes the /btw session directory to the SDK child", async () => {
		const captured = captureSdkRequests();
		const harness = await sdkPathHarness([btwExtension]);
		expect(harness.session.cwd).not.toBe(process.cwd());

		await harness.session.prompt("/btw explain the current task");

		expect(captured).toHaveLength(1);
		expect(captured[0]?.cwd).toBe(harness.session.cwd);
	});

	it("passes the look_at session directory to the SDK child", async () => {
		const captured = captureSdkRequests();
		const harness = await sdkPathHarness([lookAtExtension]);
		expect(harness.session.cwd).not.toBe(process.cwd());

		const result = await harness.session.executeTool("look_at", { image_data: PNG, goal: "describe" });

		expect(captured, JSON.stringify(result)).toHaveLength(1);
		expect(captured[0]?.cwd).toBe(harness.session.cwd);
	});

	it("passes the demoted session directory to a background probe-back child", async () => {
		const captured = captureSdkRequests();
		let now = 0;
		const harness = await sdkPathHarness([], {
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
		]);
		await harness.session.prompt("schedule probe-back");
		const deadline = scheduled.get(60_000);
		if (!deadline) throw new Error("deadline probe timer missing");
		const result = Promise.withResolvers<void>();
		const timeout = realSetTimeout(() => result.reject(new Error("probe-back did not settle")), 5_000);
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "retry_probe_result") result.resolve();
		});
		try {
			now = 60_001;
			deadline();
			await result.promise;

			expect(captured).toHaveLength(1);
			expect(captured[0]?.cwd).toBe(harness.session.cwd);
		} finally {
			clearTimeout(timeout);
			unsubscribe();
		}
	});
});
