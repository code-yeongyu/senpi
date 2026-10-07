import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// https://github.com/code-yeongyu/senpi/issues/2894
// A usage limit on the session model starts the fallback walk. When the next rung
// is refused by the context-window guard, the walk used to stop there: the rungs
// after it were never tried and no `retry_fallback_exhausted` was emitted, so the
// turn just ended on the original error.
const primary = "faux/faux-roomy";
const small = "faux/faux-small";
const spacious = "faux/faux-spacious";
const usageLimit = "billing error: insufficient_quota";

describe("#2894 fallback past a rung the context-window guard refuses", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function harnessWithChain(chain: string[]): Promise<Harness> {
		const harness = await createHarness({
			models: [
				{ id: "faux-roomy", contextWindow: 200_000 },
				{ id: "faux-small", contextWindow: 5_120 },
				{ id: "faux-spacious", contextWindow: 200_000 },
			],
			settings: {
				retry: { enabled: true, maxRetries: 0, baseDelayMs: 60_000, fallbackChains: { [primary]: chain } },
			},
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "context ".repeat(3_000) }],
			timestamp: Date.now(),
		});
		return harness;
	}

	it("#given a chain whose next rung cannot hold the context #when the session model hits a usage limit #then the rung after it answers in the same turn", async () => {
		const harness = await harnessWithChain([small, spacious]);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: usageLimit }),
			fauxAssistantMessage("answer from the spacious rung"),
		]);

		await harness.session.prompt("hello");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-roomy", "faux-spacious"]);
		expect(harness.session.model?.id).toBe("faux-spacious");
		expect(harness.eventsOfType("model_change_rejected").map((event) => event.model.id)).toEqual(["faux-small"]);
		expect(harness.eventsOfType("retry_fallback_exhausted")).toEqual([]);
	});

	it("#given a chain whose next rung cannot fit and whose rung after it fits once trimmed #when the session model hits a usage limit #then the first is refused, the second is trimmed once and answers", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-roomy", contextWindow: 400_000, maxTokens: 32_000 },
				{ id: "faux-small", contextWindow: 5_120 },
				{ id: "faux-mid", contextWindow: 60_000, maxTokens: 8_000 },
			],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 60_000,
					fallbackChains: { [primary]: [small, "faux/faux-mid"] },
				},
			},
		});
		harnesses.push(harness);
		const model = harness.getModel();
		let timestamp = 1;
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "do the task" }],
			timestamp: timestamp++,
		});
		for (let step = 0; step < 30; step++) {
			const toolCallId = `call-${step}`;
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage("running a tool", { timestamp: timestamp++ }),
				content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: `step ${step}` } }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "toolUse",
			});
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: `output ${step} `.repeat(1_600) }],
				isError: false,
				timestamp: timestamp++,
			});
		}
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: usageLimit }),
			fauxAssistantMessage("answer from the trimmed rung"),
		]);

		await harness.session.prompt("continue");

		expect(harness.eventsOfType("model_change_rejected").map((event) => event.model.id)).toEqual(["faux-small"]);
		expect(harness.eventsOfType("resume_context_reduced")).toHaveLength(1);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-roomy", "faux-mid"]);
		expect(harness.session.model?.id).toBe("faux-mid");
	});

	it("#given a chain whose only remaining rung cannot hold the context #when the session model hits a usage limit #then fallback exhaustion is emitted once and the turn ends on the error", async () => {
		const harness = await harnessWithChain([small]);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: usageLimit })]);

		await harness.session.prompt("hello");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-roomy"]);
		expect(harness.session.model?.id).toBe("faux-roomy");
		expect(harness.eventsOfType("retry_fallback_exhausted")).toMatchObject([
			{ chainKey: primary, lastError: usageLimit },
		]);
	});
});
