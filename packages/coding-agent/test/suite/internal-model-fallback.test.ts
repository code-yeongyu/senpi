import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	fauxAssistantMessage,
	lazyStream,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type InternalStreamOptions,
	type InternalStreamRuntime,
	streamInternalModel,
} from "../../src/core/internal-model-request.ts";
import { registerFallbackModels } from "./fallback-provider-fixture.ts";
import { createHarness, type Harness } from "./harness.ts";

// senpi#1889: auxiliary requests (compaction, title, branch summary, /btw, look_at, speculative
// summaries) follow the session's model-fallback chain instead of failing on the first model.

function seedHistory(harness: Harness): void {
	const model = harness.session.model!;
	for (const label of ["old", "recent"]) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: label.padEnd(400, "x") }],
			timestamp: Date.now() - 2000,
		});
		const assistant = fauxAssistantMessage(label.padEnd(400, "y"), { timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage({
			...assistant,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...assistant.usage, input: 2500, totalTokens: 2500 },
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("auxiliary requests follow the session's model-fallback chain", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("a compaction whose model fails is summarized by the chain's next model; the session model stays", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 4000, maxTokens: 3000 },
				{ id: "faux-2", contextWindow: 4000, maxTokens: 3000 },
			],
			tools: [],
			settings: {
				retry: { enabled: true, maxRetries: 0, fallbackChains: { "faux/faux-1": ["other-faux/faux-2"] } },
				compaction: {
					reserveTokens: 10,
					modelOverrides: { "faux/faux-1": { reserveTokens: 2000, keepRecentTokens: 150 } },
				},
			},
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "other-faux", ["faux-2"]);
		seedHistory(harness);
		harness.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "500 server_error: summarizer crashed" }),
			fauxAssistantMessage("fallback summary"),
		]);

		await harness.session.compact();

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
		expect(harness.sessionManager.getEntries().find((entry) => entry.type === "compaction")).toMatchObject({
			summary: expect.stringContaining("fallback summary"),
		});
		expect(harness.eventsOfType("internal_model_fallback")).toEqual([
			expect.objectContaining({ source: "compaction", to: expect.stringContaining("other-faux/faux-2") }),
		]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(`${harness.session.model?.provider}/${harness.session.model?.id}`).toBe("faux/faux-1");
	});
});

describe("streamInternalModel", () => {
	let agentDir: string;
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "internal-request-"));
	});
	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	function model(provider: string, id: string, input: Model<Api>["input"] = ["text"]): Model<Api> {
		return {
			id,
			provider,
			api: "openai-completions",
			name: id,
			baseUrl: "https://example.invalid",
			maxTokens: 2048,
			contextWindow: 128_000,
			reasoning: false,
			thinkingLevelMap: {},
			input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
	}

	function eventStream(event: AssistantMessageEvent): AssistantMessageEventStream {
		return lazyStream(model("test", "test"), async () => ({
			async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
				yield event;
			},
		}));
	}

	const ok = (): AssistantMessageEventStream =>
		eventStream({ type: "done", reason: "stop", message: fauxAssistantMessage("ok", { timestamp: 0 }) });
	const failed = (): AssistantMessageEventStream =>
		eventStream({
			type: "error",
			reason: "error",
			error: fauxAssistantMessage("", { stopReason: "error", errorMessage: "primary failed", timestamp: 0 }),
		});

	function runtimeOf(models: Model<Api>[], answers: Array<() => AssistantMessageEventStream>) {
		const attempts: Array<{ model: Model<Api>; options: InternalStreamOptions | undefined }> = [];
		const runtime: InternalStreamRuntime = {
			streamSimple: (next, _context, options) => {
				attempts.push({ model: next, options });
				return (answers[attempts.length - 1] ?? ok)();
			},
			getModels: () => models,
			getModel: (provider, id) => models.find((entry) => entry.provider === provider && entry.id === id),
			isUsingOAuth: () => false,
			isFallbackEligible: () => true,
			hasConfiguredAuth: () => true,
		};
		return { runtime, attempts };
	}

	const chain = (from: string, to: string) => ({
		getRetryFallbackSettings: () => ({ modelFallback: true, chains: { [from]: [to] } }),
	});

	async function drain(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent["type"][]> {
		const types: AssistantMessageEvent["type"][] = [];
		for await (const event of stream) types.push(event.type);
		return types;
	}

	it("sends a fallback rung none of the caller's resolved credential material", async () => {
		const primary = model("anthropic", "primary");
		const fallback = model("openai", "fallback");
		const { runtime, attempts } = runtimeOf([primary, fallback], [failed, ok]);
		const text: Context = { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 0 }] };

		const types = await drain(
			streamInternalModel(
				runtime,
				primary,
				text,
				{
					apiKey: "primary-key",
					headers: { authorization: "Bearer primary-key" },
					extraBody: { x: 1 },
					env: { FOO: "bar" },
					reasoningEffort: "high",
				},
				{ source: "test", agentDir, settings: chain("anthropic/primary", "openai/fallback") },
			),
		);

		expect(types).toContain("done");
		expect(attempts.map((attempt) => attempt.model.id)).toEqual(["primary", "fallback"]);
		expect(attempts[1]?.options).toMatchObject({ maxRetries: 0 });
		for (const key of ["apiKey", "headers", "extraBody", "env", "reasoningEffort"])
			expect(attempts[1]?.options).not.toHaveProperty(key);
	});

	it("never moves an image request to a text-only fallback", async () => {
		const primary = model("anthropic", "primary", ["text", "image"]);
		const textOnly = model("openai", "fallback", ["text"]);
		const { runtime, attempts } = runtimeOf([primary, textOnly], [failed]);
		const image: Context = {
			systemPrompt: "s",
			messages: [{ role: "user", content: [{ type: "image", data: "data", mimeType: "image/png" }], timestamp: 0 }],
		};

		const types = await drain(
			streamInternalModel(
				runtime,
				primary,
				image,
				{},
				{
					source: "test",
					agentDir,
					settings: chain("anthropic/primary", "openai/fallback"),
				},
			),
		);

		expect(types).toEqual(["error"]);
		expect(attempts.map((attempt) => attempt.model.id)).toEqual(["primary"]);
	});
});
