import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// senpi#6893: a model the user picks while the turn sits in the retry/fallback
// loop is the model the very next attempt uses - the loop neither ends with
// "Retry cancelled" nor charges the old model's failure to the picked one.

const overloaded = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });

const echoTool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo text back",
	parameters: Type.Object({ text: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
};

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
		const retryTexts = harness.eventsOfType("auto_retry_start").slice(-2);
		expect(retryTexts[1]?.errorMessage).toBe(retryTexts[0]?.errorMessage);
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

	it("keeps the backoff and the budget when the pick is the model the retry already uses", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }],
			settings: { retry: { enabled: true, baseDelayMs: 200, maxRetries: 2 } },
		});
		harnesses.push(harness);
		harness.setResponses([overloaded(), overloaded(), overloaded(), fauxAssistantMessage("never requested")]);
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && event.delayMs > 0) {
				void harness.session.setModel(pickModel(harness, "faux-1"));
			}
		});

		await harness.session.prompt("re-pick the same model");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1", "faux-1"]);
		expect(
			harness
				.eventsOfType("auto_retry_start")
				.map((event) => ({ attempt: event.attempt, waited: event.delayMs > 0 })),
		).toEqual([
			{ attempt: 1, waited: true },
			{ attempt: 2, waited: true },
		]);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, attempt: 2 }]);
		expect(harness.getPendingResponseCount()).toBe(1);
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
	it("charges a virtual pick's own routed failure to it once its first request has started", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "small" }],
			tools: [echoTool],
			settings: { retry: { enabled: true, baseDelayMs: 200, maxRetries: 1 } },
			extensionFactories: [
				(pi) => {
					pi.registerVirtualModel({
						provider: "router",
						id: "auto",
						name: "Auto",
						contextWindow: 128_000,
						route: (_request, ctx) => {
							const small = ctx.modelRegistry.find("faux", "small");
							if (!small) throw new Error("missing faux/small");
							return { model: small, thinkingLevel: "off" };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
		harness.setResponses([
			async () => {
				// The user picks the virtual model while this physical request is in flight; it then succeeds with a tool call.
				const router = runtime.getModel("router", "auto");
				if (!router) throw new Error("missing router/auto");
				await harness.session.setModel(router);
				return fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" });
			},
			overloaded(),
			fauxAssistantMessage("routed answer"),
		]);

		await harness.session.prompt("switch to the router mid-run");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "small", "small"]);
		// The routed request's failure is the pick's own: a normal backoff, not the immediate in-flight handoff.
		expect(
			harness
				.eventsOfType("auto_retry_start")
				.map((event) => ({ attempt: event.attempt, waited: event.delayMs > 0 })),
		).toEqual([{ attempt: 1, waited: true }]);
	});

	it("gives the pick a fresh budget when the switch lands after the wait, before the continuation", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
			fallbackNow: () => now,
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
			overloaded(),
			fauxAssistantMessage("picked model answer"),
		]);
		harness.session.subscribe((event) => {
			// The fallback's own backoff outlives the primary's cooldown, so the revert runs after the wait.
			if (event.type === "auto_retry_start" && event.delayMs > 0) now += 10 * 60_000;
			// The revert is emitted between the end of the wait and the continuation: the user picks there.
			if (event.type === "retry_fallback_reverted") void harness.session.setModel(pickModel(harness, "faux-3"));
		});

		await harness.session.prompt("pick after the wait");

		// faux-3 gets its own budget of two: one failure, then the answer.
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual([
			"faux-1",
			"faux-1",
			"faux-1",
			"faux-2",
			"faux-3",
			"faux-3",
		]);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true }]);
	});
});
