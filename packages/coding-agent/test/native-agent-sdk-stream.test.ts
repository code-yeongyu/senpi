import { getModels } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { type NativeAgentRequest, streamNativeAgent } from "../src/core/extensions/builtin/native-agent-sdk/stream.ts";

const model = getModels("openai-codex")[0];
if (model === undefined) throw new Error("openai-codex catalog is empty");

describe("native agent SDK stream bridge", () => {
	it("forwards flattened context, text, and usage", async () => {
		let request: NativeAgentRequest | undefined;
		const stream = streamNativeAgent(
			model,
			{
				systemPrompt: "system",
				messages: [
					{ role: "user", content: "hello", timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "text", text: "prior" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2,
					},
				],
			},
			undefined,
			async function* (received) {
				request = received;
				yield { type: "text", text: "native answer" };
				yield { type: "usage", input: 10, output: 3, cacheRead: 2, cacheWrite: 1 };
			},
		);

		const result = await stream.result();

		expect(request?.prompt).toContain("system");
		expect(request?.prompt).toContain("hello");
		expect(request?.prompt).toContain("prior");
		expect(result.content).toEqual([{ type: "text", text: "native answer" }]);
		expect(result.usage).toMatchObject({ input: 10, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 16 });
		expect(result.stopReason).toBe("stop");
	});

	it("maps failures and aborts to terminal assistant messages", async () => {
		const failed = streamNativeAgent(model, { messages: [] }, undefined, async function* () {
			yield { type: "text", text: "" };
			throw new Error("sdk failed");
		});
		expect(await failed.result()).toMatchObject({ stopReason: "error", errorMessage: "sdk failed" });

		const controller = new AbortController();
		controller.abort();
		const aborted = streamNativeAgent(model, { messages: [] }, { signal: controller.signal }, async function* () {
			yield { type: "text", text: "" };
			throw new Error("cancelled");
		});
		expect(await aborted.result()).toMatchObject({ stopReason: "aborted", errorMessage: "Operation aborted" });
	});

	it("accepts an empty successful native response", async () => {
		const stream = streamNativeAgent(model, { messages: [] }, undefined, async function* () {});
		expect(await stream.result()).toMatchObject({ content: [], stopReason: "stop" });
	});
});
