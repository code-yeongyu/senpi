import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

type CheckCompaction = (assistantMessage: AssistantMessage) => Promise<void>;
type RunAutoCompaction = (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;

function getCheckCompaction(session: Harness["session"]): CheckCompaction {
	const value: unknown = Reflect.get(session, "_checkCompaction");
	if (typeof value !== "function") {
		throw new Error("AgentSession._checkCompaction is not available for regression tests");
	}
	return async (assistantMessage) => {
		await value.call(session, assistantMessage);
	};
}

function stubRunAutoCompaction(session: Harness["session"]) {
	const stub = vi.fn<RunAutoCompaction>(async () => true);
	Reflect.set(session, "_runAutoCompaction", stub);
	return stub;
}

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("context overflow recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
		vi.restoreAllMocks();
	});

	it("auto-compacts when a provider reports the canonical model behind the selected alias", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "quotio-openai",
			upstreamModelId: "gpt-5.5",
			models: [
				{
					id: "gpt-5.5-fast",
					contextWindow: 272_000,
				},
			],
			settings: { compaction: { enabled: true, reserveTokens: 16_384 } },
		});
		harnesses.push(harness);
		const selectedModel = harness.getModel();
		const userMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "read /tmp/h2.jpg" }],
			timestamp: Date.now() - 500,
		};
		const overflowMessage: AssistantMessage = {
			...fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage:
					"Error Code context_too_large: Your input exceeds the context window of this model. Please adjust your input and try again.",
				timestamp: Date.now(),
			}),
			api: selectedModel.api,
			provider: selectedModel.provider,
			model: "gpt-5.5",
			usage: zeroUsage(),
		};
		harness.session.agent.state.messages = [userMessage, overflowMessage];

		const runAutoCompactionSpy = stubRunAutoCompaction(harness.session);

		await getCheckCompaction(harness.session)(overflowMessage);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("overflow", true);
	});

	it("does not auto-compact unrelated same-provider model overflow below the threshold", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "quotio-openai",
			models: [
				{
					id: "gpt-5.5-fast",
					contextWindow: 272_000,
				},
			],
			settings: { compaction: { enabled: true, reserveTokens: 16_384 } },
		});
		harnesses.push(harness);
		const selectedModel = harness.getModel();
		const overflowMessage: AssistantMessage = {
			...fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage:
					"Error Code context_too_large: Your input exceeds the context window of this model. Please adjust your input and try again.",
				timestamp: Date.now(),
			}),
			api: selectedModel.api,
			provider: selectedModel.provider,
			model: "unrelated-model",
			usage: zeroUsage(),
		};
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() - 500 },
			overflowMessage,
		];

		const runAutoCompactionSpy = stubRunAutoCompaction(harness.session);

		await getCheckCompaction(harness.session)(overflowMessage);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});
});
