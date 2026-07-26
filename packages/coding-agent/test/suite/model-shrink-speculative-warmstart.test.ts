import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
	}
});

function seedSessionWithUsage(harness: Harness, inputTokens: number): void {
	const model = harness.getModel();
	const assistant: AgentMessage = {
		role: "assistant",
		content: [{ type: "text", text: "done ".repeat(80_000) }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: inputTokens,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "big session" }],
		timestamp: Date.now() - 1_000,
	});
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function captureNextProviderContext(
	harness: Harness,
	timeoutMs = 5_000,
): Promise<{ context: Context; signal: AbortSignal | undefined }> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("timed out waiting for provider call")), timeoutMs);
		harness.faux.setResponses([
			(context, options) => {
				clearTimeout(timeout);
				resolve({ context, signal: options?.signal });
				return fauxAssistantMessage("warm summary");
			},
		]);
	});
}

const BIG_MODEL = { id: "faux-big", contextWindow: 1_000_000, maxTokens: 16_384 };
const SMALL_MODEL = { id: "faux-small", contextWindow: 100_000, maxTokens: 16_384 };

describe("model window shrink speculative warm start", () => {
	it("starts a speculative summary at switch time when history exceeds the smaller window", async () => {
		const harness = await createHarness({
			models: [BIG_MODEL, SMALL_MODEL],
			extensionFactories: [compactionExtension],
		});
		harnesses.push(harness);
		seedSessionWithUsage(harness, 600_000);
		const smallModel = harness.getModel("faux-small");
		if (!smallModel) throw new Error("faux-small not registered");
		const providerCall = captureNextProviderContext(harness);

		await harness.session.setModel(smallModel);

		const { context: summarizationContext, signal } = await providerCall;
		const messages = summarizationContext.messages;
		const lastMessage = messages[messages.length - 1];
		const lastText =
			lastMessage && Array.isArray(lastMessage.content)
				? lastMessage.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n")
				: "";
		expect(lastText).toContain("<summary>");

		const bigModel = harness.getModel("faux-big");
		if (!bigModel) throw new Error("faux-big not registered");
		await harness.getExtensionRunner().emitModelSelect({
			type: "model_select",
			model: smallModel,
			previousModel: bigModel,
			source: "set",
			systemPrompt: harness.session.systemPrompt,
			systemPromptOptions: { cwd: harness.tempDir },
		});
		expect(signal?.aborted).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
	});
});
