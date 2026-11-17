import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// senpi#6893: a model the user picks while the turn sits in the retry/fallback
// loop is the model the very next attempt uses - the loop neither ends with
// "Retry cancelled" nor charges the old model's failure to the picked one.

const overloaded = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });

function pickModel(harness: Harness, id: string) {
	const model = harness.getModel(id);
	if (!model) throw new Error(`missing ${id}`);
	return model;
}

describe("senpi#6893 manual model switch during a retry loop", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("continues at once on the picked model when the switch lands in a fallback backoff", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
			settings: {
				retry: {
					enabled: true,
					baseDelayMs: 200,
					maxRetries: 2,
					fallbackChains: { "faux/faux-1": ["faux/faux-2"] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			overloaded(),
			overloaded(),
			overloaded(),
			overloaded(),
			fauxAssistantMessage("answer from the picked model"),
		]);
		let switchAt: number | undefined;
		harness.session.subscribe((event) => {
			const fallbackActive = harness.eventsOfType("retry_fallback_applied").length > 0;
			if (event.type === "auto_retry_start" && event.delayMs > 0 && fallbackActive && switchAt === undefined) {
				switchAt = harness.events.length;
				void harness.session.setModel(pickModel(harness, "faux-3"));
			}
		});

		await harness.session.prompt("flaky then switch");

		expect(switchAt).toBeDefined();
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual([
			"faux-1",
			"faux-1",
			"faux-1",
			"faux-2",
			"faux-3",
		]);
		const afterSwitch = harness.events.slice(switchAt);
		expect(afterSwitch.filter((event) => event.type === "auto_retry_start")).toMatchObject([
			{ attempt: 1, delayMs: 0 },
		]);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
		expect(harness.session.model?.id).toBe("faux-3");
		expect(harness.session.isRetrying).toBe(false);
	});

	it("cuts a same-model backoff short and gives the picked model a fresh budget", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-3" }],
			settings: { retry: { enabled: true, baseDelayMs: 200, maxRetries: 2 } },
		});
		harnesses.push(harness);
		harness.setResponses([overloaded(), overloaded(), overloaded(), fauxAssistantMessage("picked model answer")]);
		let switchAt: number | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && event.attempt === 2 && switchAt === undefined) {
				switchAt = harness.events.length;
				void harness.session.setModel(pickModel(harness, "faux-3"));
			}
		});

		await harness.session.prompt("flaky then switch");

		// The picked model's own failure is its attempt 2 of 2: the old model's two
		// spent attempts do not count against it.
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1", "faux-3", "faux-3"]);
		const afterSwitch = harness.events.slice(switchAt);
		expect(
			afterSwitch
				.filter((event) => event.type === "auto_retry_start")
				.map((event) => ({ attempt: event.attempt, cut: event.delayMs === 0 })),
		).toEqual([
			{ attempt: 1, cut: true },
			{ attempt: 2, cut: false },
		]);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 2 }]);
	});

	it("does not charge the in-flight old model's failure to the picked model", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
			settings: {
				retry: {
					enabled: true,
					baseDelayMs: 200,
					maxRetries: 0,
					fallbackChains: { "faux/faux-1": ["faux/faux-2"], "faux/faux-3": ["faux/faux-2"] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				// The user picks another model while this request is still in flight.
				await harness.session.setModel(pickModel(harness, "faux-3"));
				return overloaded();
			},
			fauxAssistantMessage("picked model answer"),
		]);

		await harness.session.prompt("switch mid-request");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-3"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, delayMs: 0 }]);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
		expect(harness.session.model?.id).toBe("faux-3");
	});

	it("still cancels the backoff with one 'Retry cancelled' on an explicit abort", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-3" }],
			settings: { retry: { enabled: true, baseDelayMs: 60_000, maxRetries: 2 } },
		});
		harnesses.push(harness);
		harness.setResponses([overloaded(), fauxAssistantMessage("never requested")]);
		let abortPromise: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && abortPromise === undefined) abortPromise = harness.session.abort();
		});

		await harness.session.prompt("abort the backoff");
		await abortPromise;

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, finalError: "Retry cancelled" }]);
	});
});
