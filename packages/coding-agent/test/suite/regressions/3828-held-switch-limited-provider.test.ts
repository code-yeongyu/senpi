import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { createHarness, type Harness } from "../harness.ts";

// #3828 (and omo#10746): a desktop user's Claude subscription hit its limit in a long 1M-window
// thread; they switched to a ~500k-window GPT model. The switch was held for one compaction, and
// the next send asked the LIMITED Claude model to write that summary. It failed, so the switch
// never applied and the user read "cannot switch ... compact the session, then retry". The
// session must not depend on the provider that just refused: the next turn runs on the new model.

const accountLimit =
	'429 {"error":{"type":"rate_limit_error","message":"You have hit your session limit; resets 11pm"}}';

async function limitedSessionWithHeldSwitch(): Promise<{ harness: Harness; requests: string[] }> {
	const harness = await createHarness({
		models: [{ id: "claude-1m", contextWindow: 1_000_000, maxTokens: 32_000 }],
		tools: [],
		settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: true } },
		extensionFactories: [compactionExtension],
		fallbackNow: () => 0,
	});
	const primary = harness.getModel();
	harness.modelRegistry.registerProvider("gpt-sub", {
		api: primary.api,
		apiKey: "faux-key",
		baseUrl: primary.baseUrl,
		models: [
			{
				id: "gpt-500k",
				name: "GPT 500k",
				contextWindow: 500_000,
				maxTokens: 128_000,
				reasoning: false,
				input: ["text"],
				cost: primary.cost,
			},
		],
	});
	for (const text of ["large live context ".repeat(60_000), "continue"]) {
		harness.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
		const response = fauxAssistantMessage("earlier response");
		harness.sessionManager.appendMessage({
			...response,
			provider: primary.provider,
			model: primary.id,
			usage: { ...response.usage, input: 600_000, totalTokens: 601_000 },
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	const target = harness.session.modelRuntime.getModel("gpt-sub", "gpt-500k");
	if (!target) throw new Error("missing target fixture");
	await harness.session.setModel(target);
	expect(harness.session.pendingModelSwitch?.model.id).toBe("gpt-500k");

	const requests: string[] = [];
	// The account stays at its limit: every request to it is refused, as a real session limit is.
	const respond: Parameters<typeof harness.setResponses>[0][number] = (_context, _options, _state, model) => {
		requests.push(`${model.provider}/${model.id}`);
		return model.id === "claude-1m"
			? fauxAssistantMessage("", { stopReason: "error", errorMessage: accountLimit })
			: fauxAssistantMessage("answered on the new model");
	};
	harness.setResponses(Array.from({ length: 12 }, () => respond));
	return { harness, requests };
}

describe("#3828 a held switch whose summarizer hits its limit still applies", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("the next turn runs on the new model without a manual step", async () => {
		const { harness, requests } = await limitedSessionWithHeldSwitch();
		harnesses.push(harness);

		await harness.session.prompt("continue after switching");

		expect(harness.eventsOfType("model_change_rejected")).toEqual([]);
		expect(harness.session.model?.id).toBe("gpt-500k");
		expect(harness.session.pendingModelSwitch).toBeUndefined();
		expect(requests.at(-1)).toBe("gpt-sub/gpt-500k");
		const answer = harness.session.state.messages.findLast((message) => message.role === "assistant");
		expect(answer?.role === "assistant" ? answer.content : undefined).toEqual([
			{ type: "text", text: "answered on the new model" },
		]);
	});
});
