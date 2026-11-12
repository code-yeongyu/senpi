import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

// omo#13243: a turn that fails on a pinned model ends with the typed report a spent chain gives, naming the model.
const primary = "faux/faux-1";
const fallback = "faux/faux-2";

/** A later run on the real admission path that settles with no assistant reply: its admission write fails. */
async function settleWithoutReply(harness: Harness): Promise<void> {
	const settledBefore = harness.eventsOfType("agent_settled").length;
	const storageError = Object.assign(new Error("EISDIR: cannot persist admission"), { code: "EISDIR" });
	await expect(
		harness.session.prompt("refused at admission", {
			source: "rpc",
			interactiveUser: false,
			onTurnAdmitted: () => {
				throw storageError;
			},
		}),
	).rejects.toBe(storageError);
	expect(harness.eventsOfType("agent_settled")).toHaveLength(settledBefore + 1);
}

describe("a pinned model's failure is reported as a typed exhaustion (omo#13243)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("names the pinned model and its error when fallback is off", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					baseDelayMs: 1,
					maxRetries: 0,
					modelFallback: false,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		await harness.session.prompt("stay pinned");

		expect(harness.eventsOfType("retry_fallback_applied")).toStrictEqual([]);
		expect(harness.eventsOfType("retry_fallback_exhausted")).toMatchObject([
			{
				chainKey: primary,
				pinned: true,
				lastError: "overloaded_error",
				failures: [{ model: primary, error: "overloaded_error" }],
			},
		]);
	});

	it("reports nothing extra for a session whose fallback is on but has no chain", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, maxRetries: 0, fallbackChains: { [primary]: [] } } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		await harness.session.prompt("no chain");

		expect(harness.eventsOfType("retry_fallback_exhausted")).toStrictEqual([]);
	});
	it("reports a non-retryable failure on a pinned model too", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					baseDelayMs: 1,
					maxRetries: 0,
					modelFallback: false,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "billing error: insufficient_quota" }),
		]);

		await harness.session.prompt("pinned hard error");

		expect(harness.eventsOfType("retry_fallback_exhausted")).toMatchObject([
			{ chainKey: primary, pinned: true, failures: [{ model: primary, reason: "hard-error" }] },
		]);
	});

	it("tells an extension's agent_settled that the pinned model's limit ended the run", async () => {
		const settled: Array<{ fallbackExhausted?: { resumeAt?: number } }> = [];
		const harness = await createHarness({
			models: [{ id: "faux-1" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, maxRetries: 0, modelFallback: false } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", (event: { fallbackExhausted?: { resumeAt?: number } }) => {
						settled.push({
							...(event.fallbackExhausted === undefined ? {} : { fallbackExhausted: event.fallbackExhausted }),
						});
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage:
					'429 {"error":{"type":"rate_limit_error","message":"You have hit your session limit; resets 11pm"}}',
			}),
		]);

		await harness.session.prompt("pinned limit");
		await harness.session.waitForSettledSessionWork();

		expect(harness.eventsOfType("retry_fallback_exhausted")).toMatchObject([{ pinned: true }]);
		expect(settled.at(-1)?.fallbackExhausted).toBeDefined();
	});

	it("reports a pinned failure once, not again on the next settle", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, maxRetries: 0, modelFallback: false } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		await harness.session.prompt("pinned once");
		expect(harness.eventsOfType("retry_fallback_exhausted")).toHaveLength(1);

		// A later settle with no assistant reply of its own (an admission that produced none) reports nothing.
		await settleWithoutReply(harness);

		expect(harness.eventsOfType("retry_fallback_exhausted")).toHaveLength(1);
	});
	it("never reports a failure kept by a run that settled with fallback on, after fallback is turned off", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, maxRetries: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		// Fallback on (no chain for this model): the failure settles with no pinned report.
		await harness.session.prompt("fallback on");
		expect(harness.eventsOfType("retry_fallback_exhausted")).toStrictEqual([]);

		// Fallback turned off later (a /fallback toggle or an RPC override), then a settle with no reply of its own.
		harness.settingsManager.applyOverrides({ retry: { modelFallback: false } });
		await settleWithoutReply(harness);

		expect(harness.eventsOfType("retry_fallback_exhausted")).toStrictEqual([]);
	});
});
