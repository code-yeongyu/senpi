import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { registerFallbackModels } from "./fallback-provider-fixture.ts";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "other-faux/faux-2";
const temporaryError = () =>
	fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider rejected the request permanently" });
const spentError = () =>
	fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: '429 {"type":"usage_limit_reached","message":"The usage limit has been reached"}',
	});
const wake = { customType: "monitor", content: "continue", display: false };
const calledModels = (harness: Harness) => harness.faux.getCallLog().map((call) => call.modelId);

describe("fallback recovery on custom wakes", () => {
	const harnesses: Harness[] = [];
	let now = 0;

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		now = 0;
	});

	async function chain(
		policy: "cooldown-expiry" | "never" = "cooldown-expiry",
		reciprocal = false,
		maxRetries = 0,
	): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: {
					enabled: true,
					maxRetries,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback], ...(reciprocal ? { [fallback]: [primary] } : {}) },
					fallbackRevertPolicy: policy,
				},
			},
		});
		registerFallbackModels(harness, "other-faux", ["faux-2"]);
		harnesses.push(harness);
		return harness;
	}

	it.each([
		["expired", 6 * 60_000, "faux-1", 1],
		["active", 1, "faux-2", 0],
	] as const)("uses the right provider for an idle wake with %s cooldown", async (_name, elapsed, model, reverts) => {
		const harness = await chain();
		harness.setResponses([temporaryError(), fauxAssistantMessage("fallback"), fauxAssistantMessage("wake")]);
		await harness.session.prompt("first");
		now += elapsed;

		await harness.session.sendCustomMessage(wake, { triggerTurn: true });

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2", model]);
		expect(harness.eventsOfType("retry_fallback_reverted")).toHaveLength(reverts);
	});

	it("wraps from a spent chain tail to a primary recovered within the turn", async () => {
		const harness = await chain();
		harness.setResponses([
			temporaryError(),
			() => {
				now += 6 * 60_000;
				return spentError();
			},
			fauxAssistantMessage("primary recovered"),
		]);

		await harness.session.prompt("first");

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2", "faux-1"]);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.eventsOfType("retry_fallback_exhausted")).toEqual([]);
	});

	it("exhausts both spent accounts without ping-pong and retains a refused wake", async () => {
		const harness = await chain();
		harness.setResponses([spentError(), spentError()]);
		await harness.session.prompt("first");

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2"]);
		expect(harness.session.messages.at(-1)).toMatchObject({
			stopReason: "error",
		});
		await expect(harness.session.sendCustomMessage(wake, { triggerTurn: true })).rejects.toMatchObject({
			name: "AccountUsageLimitError",
		});
		expect(calledModels(harness)).toEqual(["faux-1", "faux-2"]);
		harness.setResponses([fauxAssistantMessage("retained wake")]);
		now += 31 * 60_000;
		await harness.session.prompt("after reset");
		expect(
			harness.session.messages.filter((message) => message.role === "custom" && message.customType === "monitor"),
		).toHaveLength(1);
	});

	it("does not restore while a custom trigger is queued during streaming", async () => {
		const harness = await chain();
		harness.setResponses([
			temporaryError(),
			fauxAssistantMessage("fallback"),
			async () => {
				now += 6 * 60_000;
				await harness.session.sendCustomMessage(wake, { triggerTurn: true });
				expect(harness.session.model?.id).toBe("faux-2");
				expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
				return fauxAssistantMessage("streamed");
			},
			fauxAssistantMessage("queued wake"),
		]);
		await harness.session.prompt("first");
		await harness.session.sendCustomMessage({ ...wake, customType: "start" }, { triggerTurn: true });

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2", "faux-2", "faux-2"]);
	});

	it("keeps never policy when the tail fails after the primary cooldown expires", async () => {
		const harness = await chain("never");
		harness.setResponses([
			temporaryError(),
			() => {
				now += 6 * 60_000;
				return spentError();
			},
		]);
		await harness.session.prompt("first");

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2"]);
		expect(harness.session.messages.at(-1)).toMatchObject({ stopReason: "error" });
	});

	it("retains an idle wake cancelled during awaited primary restoration", async () => {
		const harness = await chain();
		harness.setResponses([temporaryError(), fauxAssistantMessage("fallback")]);
		await harness.session.prompt("first");
		now += 6 * 60_000;
		let abort: Promise<void> | undefined;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "retry_fallback_reverted") abort = harness.session.abort();
		});
		await harness.session.sendCustomMessage(wake, { triggerTurn: true });
		unsubscribe();
		await abort;

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2"]);
		expect(harness.agent.hasQueuedMessages()).toBe(true);
		harness.setResponses([fauxAssistantMessage("retained wake")]);
		await harness.session.prompt("resume");
		expect(
			harness.session.messages.filter((message) => message.role === "custom" && message.customType === "monitor"),
		).toHaveLength(1);
	});

	it.each(["display", "nextTurn"] as const)("does not restore for a %s-only custom message", async (mode) => {
		const harness = await chain();
		harness.setResponses([temporaryError(), fauxAssistantMessage("fallback")]);
		await harness.session.prompt("first");
		now += 6 * 60_000;

		await harness.session.sendCustomMessage(
			wake,
			mode === "display" ? { triggerTurn: false } : { triggerTurn: true, deliverAs: "nextTurn" },
		);

		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
		expect(calledModels(harness)).toEqual(["faux-1", "faux-2"]);
	});

	it.each(["never", "refusal-pin"] as const)("holds the primary for %s even in a reciprocal chain", async (guard) => {
		const harness = await chain(guard === "never" ? "never" : "cooldown-expiry", true, guard === "never" ? 0 : 1);
		harness.setResponses([
			guard === "never"
				? temporaryError()
				: fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "Stream ended with refusal",
						stopDetails: { type: "refusal" },
					}),
			() => {
				now += 6 * 60_000;
				return temporaryError();
			},
		]);
		await harness.session.prompt("first");

		expect(calledModels(harness)).toEqual(["faux-1", "faux-2"]);
		expect(harness.eventsOfType("retry_fallback_reverted")).toEqual([]);
	});
});
