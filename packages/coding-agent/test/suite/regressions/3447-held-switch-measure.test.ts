import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// https://github.com/code-yeongyu/senpi/issues/3447
// A held switch is admitted on the reported usage. After its compaction it used to
// re-check the target with the bare per-message estimate, so a transcript the
// estimate undercounts was switched onto a window it does not fit.
const reportedInput = 321_000;

function seedUndercountedContext(harness: Harness, resultChars = 2_000): void {
	const model = harness.getModel();
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "do the task" }],
		timestamp: 1,
	});
	const steps = 20;
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
			content: [{ type: "text", text: `result ${step} `.padEnd(resultChars, "z") }],
			isError: false,
			timestamp: Date.now(),
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("#3447 a held switch re-checks the target with the measure it was admitted on", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("#given a held switch admitted on reported usage and a compaction that keeps the transcript #when the next send applies it #then the transcript is reduced before the switch lands", async () => {
		const harness = await createHarness({
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "372k", contextWindow: 372_000, maxTokens: 32_000 },
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						const firstMessage = event.branchEntries.find((entry) => entry.type === "message");
						if (!firstMessage) throw new Error("missing kept-transcript fixture");
						return {
							compaction: {
								summary: "compact summary",
								firstKeptEntryId: firstMessage.id,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedUndercountedContext(harness);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing held switch target fixture");
		await harness.session.setModel(target);
		expect(harness.eventsOfType("model_change_pending")).toHaveLength(1);
		harness.setResponses([fauxAssistantMessage("answered on the target model")]);

		await harness.session.prompt("continue");

		expect(harness.eventsOfType("resume_context_reduced")).toHaveLength(1);
		expect(harness.session.model?.id).toBe("372k");
	});

	it("#given a held switch whose compaction leaves a fresh summary and a short tail #when the next send applies it #then the summary is charged at its own size and the switch lands without a slice", async () => {
		const harness = await createHarness({
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "372k", contextWindow: 372_000, maxTokens: 32_000 },
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						const lastReply = event.branchEntries.findLast(
							(entry) => entry.type === "message" && entry.message.role === "assistant",
						);
						if (!lastReply) throw new Error("missing short-tail fixture");
						return {
							compaction: {
								summary: Array.from({ length: 18_000 }, (_, index) => `fact${index}`).join(" "),
								firstKeptEntryId: lastReply.id,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedUndercountedContext(harness);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing held switch target fixture");
		await harness.session.setModel(target);
		expect(harness.eventsOfType("model_change_pending")).toHaveLength(1);
		harness.setResponses([fauxAssistantMessage("answered on the target model")]);

		await harness.session.prompt("continue");

		expect(harness.eventsOfType("model_change_rejected")).toEqual([]);
		expect(harness.eventsOfType("resume_context_reduced")).toEqual([]);
		expect(harness.session.model?.id).toBe("372k");
	});
});
