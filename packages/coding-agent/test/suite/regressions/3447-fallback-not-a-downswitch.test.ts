import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../../../src/core/compaction/compaction.ts";
import { filterContextExcludedMessages } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

// https://github.com/code-yeongyu/senpi/issues/3447
// The one fit measure applies to a downswitch only. A rung whose usable window is
// the same as or larger than the session model's has no fit charge, so it must land
// without a refusal or a reduction even when the per-message estimate plus the
// switch reserves exceeds its window (the #900 shape).
const primary = "faux/faux-primary";
const usageLimit = "billing error: insufficient_quota for this model";
const maxTokens = 2_048;
const compaction = { enabled: true, reserveTokens: 5_000, speculativeEnabled: false };

function seed(harness: Harness, reportedInput: number): void {
	const model = harness.getModel();
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "do the task" }],
		timestamp: 1,
	});
	const steps = 10;
	for (let step = 0; step < steps; step++) {
		const toolCallId = `call-${step}`;
		const input = step === steps - 1 ? reportedInput : 0;
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("running a tool"),
			content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: `step ${step}` } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse",
			usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost },
		});
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: `result ${step} `.padEnd(3_000, "z") }],
			isError: false,
			timestamp: Date.now(),
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

async function seededEstimate(): Promise<number> {
	const probe = await createHarness({ models: [{ id: "faux-primary", contextWindow: 400_000, maxTokens }] });
	try {
		seed(probe, 0);
		return filterContextExcludedMessages(probe.sessionManager.buildSessionContext().messages).reduce(
			(total, message) => total + estimateTokens(message),
			0,
		);
	} finally {
		probe.cleanup();
	}
}

const rows = [
	{ name: "an equal window without reported usage", reportedInput: 0, primaryShrink: 0 },
	{ name: "an equal window with reported usage below the estimate", reportedInput: 20_000, primaryShrink: 0 },
	{ name: "a larger window without reported usage", reportedInput: 0, primaryShrink: 3_000 },
	{ name: "a larger window with reported usage below the estimate", reportedInput: 20_000, primaryShrink: 3_000 },
] as const;

describe("#3447 a fallback rung that is not a downswitch carries no fit charge", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it.each(rows)(
		"#given a rung with $name #when fallback switches #then it lands with no refusal and no reduction",
		async (row) => {
			const rungWindow = (await seededEstimate()) + 14_000;
			const harness = await createHarness({
				models: [
					{ id: "faux-primary", contextWindow: rungWindow - row.primaryShrink, maxTokens },
					{ id: "faux-rung", contextWindow: rungWindow, maxTokens },
				],
				settings: {
					compaction,
					retry: {
						enabled: true,
						maxRetries: 0,
						baseDelayMs: 60_000,
						fallbackChains: { [primary]: ["faux/faux-rung"] },
					},
				},
			});
			harnesses.push(harness);
			seed(harness, row.reportedInput);
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: usageLimit }),
				fauxAssistantMessage("answer from the rung"),
			]);

			await harness.session.prompt("continue");

			expect(harness.eventsOfType("model_change_rejected")).toEqual([]);
			expect(harness.eventsOfType("resume_context_reduced")).toEqual([]);
			expect(
				harness.faux
					.getCallLog()
					.map((call) => call.modelId)
					.slice(0, 2),
			).toEqual(["faux-primary", "faux-rung"]);
			expect(harness.session.model?.id).toBe("faux-rung");
		},
	);
});
