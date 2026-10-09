import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackCircuitsFor } from "../../src/core/retry-fallback/circuit.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";
const window = { cooldownMs: 60_000, maxCooldownMs: 1_800_000 };

const failure = (errorMessage = "HTTP 503: overloaded") =>
	fauxAssistantMessage("", { stopReason: "error", errorMessage });
const answer = () => fauxAssistantMessage("OK");

describe("fallback circuit probes and failure classes (senpi#2201 review)", () => {
	const harnesses: Harness[] = [];
	let now = 0;

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
		now = 0;
	});

	async function make(retry: Partial<NonNullable<Settings["retry"]>> = {}, siblingOf?: Harness): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			siblingOf,
			fallbackNow: () => now,
			settings: {
				retry: {
					enabled: true,
					baseDelayMs: 0,
					maxRetries: 0,
					fallbackChains: { [primary]: [fallback] },
					...retry,
				},
			},
		});
		harnesses.push(harness);
		return harness;
	}

	const breaker = (harness: Harness) => fallbackCircuitsFor(join(harness.tempDir, "agent"));
	const calledModels = (harness: Harness) => harness.faux.getCallLog().map((call) => call.modelId);

	it("opens the final chain entry when it fails with a billing error", async () => {
		const harness = await make();
		harness.setResponses([failure(), failure("400 invalid_request_error: Your credit balance is too low")]);

		await harness.session.prompt("exhaust both entries");

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2"]);
		expect(breaker(harness).isOpen(fallback, now, "sibling")).toBe(true);
	});

	it.each([
		{ errorMessage: "HTTP 429: quota exceeded", opens: true },
		{ errorMessage: "HTTP 400: out of budget", opens: true },
		{ errorMessage: "HTTP 401: invalid API key", opens: false },
		{ errorMessage: "HTTP 403: forbidden", opens: false },
	])("classifies '$errorMessage' as provider health: opens=$opens", async ({ errorMessage, opens }) => {
		const harness = await make();
		harness.setResponses([failure(errorMessage), answer()]);

		await harness.session.prompt("provider failure");

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2"]);
		expect(breaker(harness).isOpen(primary, now, "sibling")).toBe(opens);
	});

	it("keeps a 503 Retry-After longer than the cooldown for sibling sessions", async () => {
		const harness = await make();
		harness.setResponses([failure("HTTP 503: overloaded (retry-after-ms: 600000)"), answer(), answer()]);

		await harness.session.prompt("unavailable for ten minutes");
		now += 120_000;
		const sibling = await make({}, harness);
		await sibling.session.prompt("the cooldown elapsed, the provider wait did not");

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2", "faux-2"]);
	});

	it("sends exactly one request for a failed half-open probe", async () => {
		const harness = await make({ maxRetries: 2 });
		breaker(harness).open(primary, { now, ...window });
		now = 60_001;
		harness.setResponses([failure(), answer()]);

		await harness.session.prompt("probe");

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2"]);
		expect(breaker(harness).isOpen(primary, now, "sibling")).toBe(true);
	});

	it("hands the half-open probe back after a user-aborted response", async () => {
		const harness = await make();
		breaker(harness).open(primary, { now, ...window });
		now = 60_001;
		harness.setResponses([fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request aborted" })]);

		await harness.session.prompt("aborted probe");

		expect(breaker(harness).isOpen(primary, now, "sibling")).toBe(false);
	});

	it("never admits a second live probe while the first is still in flight", async () => {
		const harness = await make();
		const sibling = await make({}, harness);
		breaker(harness).open(primary, { now, ...window });
		now = 60_001;
		harness.setResponses([
			async () => {
				// when: the first probe is still in flight long past one cooldown window
				now += 60_001;
				await sibling.session.prompt("the first probe remains in flight");
				return answer();
			},
			answer(),
		]);

		await harness.session.prompt("slow probe");

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2"]);
	});

	it("aborts a probe that never answers as a provider failure and moves on", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const harness = await make();
			breaker(harness).open(primary, { now, ...window });
			now = 60_001;
			const probeStarted = Promise.withResolvers<void>();
			harness.setResponses([
				async (_context, options) => {
					probeStarted.resolve();
					await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
					return fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request aborted" });
				},
				answer(),
			]);

			let settled = false;
			const turn = harness.session.prompt("a probe that hangs").finally(() => {
				settled = true;
			});
			await probeStarted.promise;
			await vi.advanceTimersByTimeAsync(300_000);
			for (let step = 0; step < 100 && !settled; step++) await vi.advanceTimersByTimeAsync(10);
			await turn;

			expect(calledModels(harness)).toEqual(["faux-1", "faux-2"]);
			expect(breaker(harness).isOpen(primary, now, "sibling")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not send a probe-back request before the provider Retry-After elapses", async () => {
		const harness = await make({ hintedWaitCapMs: 1_000 });
		const scheduled = new Map<number, () => void>();
		const realSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, delay?: number) => {
			if (delay === 30_000 || delay === 60_000) {
				scheduled.set(delay, handler);
				return realSetTimeout(() => {}, 0);
			}
			return realSetTimeout(handler, delay);
		}) as typeof setTimeout);
		harness.setResponses([failure("HTTP 429: rate_limit_error (retry-after-ms: 60000)"), answer(), answer()]);

		await harness.session.prompt("rate limited for sixty seconds");
		const halfHintProbe = scheduled.get(30_000);
		expect(halfHintProbe).toBeDefined();
		const secondProbeAnnounced = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "retry_probe_scheduled" && event.probeIndex === 2) {
					unsubscribe();
					resolve();
				}
			});
		});
		now = 30_000;
		halfHintProbe?.();
		await secondProbeAnnounced;

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2"]);
		expect(breaker(harness).isOpen(primary, now, "sibling")).toBe(true);
	});
});
