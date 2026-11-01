import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// https://github.com/code-yeongyu/senpi/issues/3447
// A fallback to a smaller-window rung measured the live context two ways. The
// switch guard charged the provider-reported usage, while the repair step decided
// whether to reduce from a per-message character estimate. When the estimate ran
// below the reported usage (dense or CJK text, images), the repair saw "fits",
// skipped the reduction, and the guard then refused the rung on the larger
// reported figure: no reduction and a refusal, so the turn ended without a reply.
const primary = "faux/faux-roomy";
const mid = "faux/faux-mid";
const tiny = "faux/faux-tiny";
const usageLimit = "billing error: insufficient_quota for this model";
// What the provider last reported for the transcript below. The per-message
// estimate of the same transcript is far lower (roughly 10k tokens).
const reportedInputTokens = 50_000;

describe("#3447 fallback fit uses the reported usage for both the repair and the guard", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function harnessWithReportedUsage(chain: string[]): Promise<Harness> {
		const harness = await createHarness({
			models: [
				{ id: "faux-roomy", contextWindow: 400_000, maxTokens: 32_000 },
				{ id: "faux-mid", contextWindow: 60_000, maxTokens: 8_000 },
				{ id: "faux-tiny", contextWindow: 30_000, maxTokens: 4_000 },
			],
			settings: {
				retry: { enabled: true, maxRetries: 0, baseDelayMs: 60_000, fallbackChains: { [primary]: chain } },
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
		const steps = 20;
		for (let step = 0; step < steps; step++) {
			const toolCallId = `call-${step}`;
			const last = step === steps - 1;
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage("running a tool", { timestamp: timestamp++ }),
				content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: `step ${step}` } }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "toolUse",
				usage: {
					input: last ? reportedInputTokens : 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: last ? reportedInputTokens : 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: `output ${step} `.repeat(200) }],
				isError: false,
				timestamp: timestamp++,
			});
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		return harness;
	}

	it("#given a rung the per-message estimate says fits but the reported usage does not #when the session model hits a usage limit #then the transcript is reduced once and the rung answers", async () => {
		const harness = await harnessWithReportedUsage([mid]);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: usageLimit }),
			fauxAssistantMessage("answer from the mid rung"),
		]);

		await harness.session.prompt("continue");

		expect(harness.eventsOfType("model_change_rejected")).toEqual([]);
		expect(harness.eventsOfType("resume_context_reduced")).toHaveLength(1);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-roomy", "faux-mid"]);
		expect(harness.session.model?.id).toBe("faux-mid");
	});

	it("#given a rung that cannot hold the context even after reduction #when fallback is exhausted #then the exhaustion names the refused rung with its window and requirement", async () => {
		const harness = await harnessWithReportedUsage([tiny]);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: usageLimit })]);

		await harness.session.prompt("continue");

		const rejected = harness.eventsOfType("model_change_rejected");
		expect(rejected.map((event) => event.model.id)).toEqual(["faux-tiny"]);
		const [exhausted] = harness.eventsOfType("retry_fallback_exhausted");
		expect(exhausted).toMatchObject({ chainKey: primary, lastError: usageLimit });
		expect(exhausted?.refusals).toEqual([{ model: tiny, detail: rejected[0]?.detail }]);
		expect(exhausted?.refusals?.[0]?.detail).toContain("30000");
	});
});
