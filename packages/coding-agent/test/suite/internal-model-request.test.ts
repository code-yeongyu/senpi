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
	type InternalModelSettings,
	type InternalStreamRuntime,
	streamInternalModel,
} from "../../src/core/internal-model-request.ts";

let agentDir: string;
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "internal-request-"));
});
afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

function model(provider: string, id: string, inputs: Model<Api>["input"] = ["text"]): Model<Api> {
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
		input: inputs,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function imageContext(): Context {
	return {
		systemPrompt: "system",
		messages: [
			{ role: "user", content: [{ type: "image" as const, data: "data", mimeType: "image/png" }], timestamp: 0 },
		],
	};
}

function textContext(): Context {
	return { systemPrompt: "system", messages: [{ role: "user", content: "hi", timestamp: 0 }] };
}

function okEvent(): AssistantMessageEvent {
	return {
		type: "done",
		reason: "stop",
		message: fauxAssistantMessage("ok", { timestamp: 0 }),
	};
}

function errorEvent(message: string): AssistantMessageEvent {
	return {
		type: "error",
		reason: "error",
		error: fauxAssistantMessage("", { stopReason: "error", errorMessage: message, timestamp: 0 }),
	};
}

function eventStream(events: AssistantMessageEvent[]): AssistantMessageEventStream {
	return lazyStream(model("test", "test"), async () => ({
		async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
			yield* events;
		},
	}));
}

function settingsFor(sets: Record<string, readonly string[]>): InternalModelSettings {
	return {
		getRetryFallbackSettings: () => ({ modelFallback: true, chains: sets, revertPolicy: "never" }),
	};
}

interface CapturedAttempt {
	model: Model<Api>;
	options: Record<string, unknown>;
}

function makeRuntime(
	primary: RuntimeModel,
	answers: ((model: RuntimeModel) => AssistantMessageEventStream)[],
	overrides: Partial<InternalStreamRuntime> = {},
): { runtime: InternalStreamRuntime; captured: CapturedAttempt[] } {
	const captured: CapturedAttempt[] = [];
	let attempt = 0;
	const defaultModels = () => [primary];
	return {
		captured,
		runtime: {
			streamSimple: (next, _context, options) => {
				const answer = answers[Math.min(attempt, answers.length - 1)];
				captured.push({ model: next, options: { ...options } });
				attempt += 1;
				return answer(next);
			},
			getModels: () => defaultModels(),
			getModel: (provider, id) => (provider === primary.provider && id === primary.id ? primary : undefined),
			isUsingOAuth: (provider) => provider === "openai-codex",
			isFallbackEligible: () => true,
			hasConfiguredAuth: () => true,
			...overrides,
		},
	};
}

type RuntimeModel = Model<Api>;

describe("streamInternalModel", () => {
	it("strips a pre-resolved Codex OAuth apiKey before dispatch", async () => {
		const primary = model("openai-codex", "model");
		const { runtime, captured } = makeRuntime(primary, [() => eventStream([okEvent()])]);

		const events: AssistantMessageEvent[] = [];
		for await (const event of await streamInternalModel(
			runtime,
			primary,
			textContext(),
			{ apiKey: "codex-token" },
			{
				settings: settingsFor({}),
				agentDir,
			},
		)) {
			events.push(event);
		}

		expect(events.some((event) => event.type === "done")).toBe(true);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.options.apiKey).toBeUndefined();
	});

	it("drops credential material on a cross-provider fallback", async () => {
		const primarySource = model("anthropic", "primary");
		const fallbackSource = model("openai", "fallback");
		const { runtime, captured } = makeRuntime(
			primarySource,
			[() => eventStream([errorEvent("primary failed")]), () => eventStream([okEvent()])],
			{
				getModels: () => [primarySource, fallbackSource],
				getModel: (provider, id) => (provider === "openai" && id === "fallback" ? fallbackSource : undefined),
				isUsingOAuth: () => false,
			},
		);

		const events: AssistantMessageEvent[] = [];
		for await (const event of await streamInternalModel(
			runtime,
			primarySource,
			textContext(),
			{
				apiKey: "primary-key",
				headers: { authorization: "Bearer primary-key" },
				extraBody: { x: 1 },
				env: { FOO: "bar" },
				reasoningEffort: "high",
			},
			{ settings: settingsFor({ "anthropic/primary": ["openai/fallback"] }), agentDir },
		)) {
			events.push(event);
		}

		expect(events.some((event) => event.type === "done")).toBe(true);
		expect(captured).toHaveLength(2);
		expect(captured[1]?.model.id).toBe("fallback");
		expect(captured[1]?.options.apiKey).toBeUndefined();
		expect(captured[1]?.options.headers).toBeUndefined();
		expect(captured[1]?.options.extraBody).toBeUndefined();
		expect(captured[1]?.options.env).toBeUndefined();
		expect(captured[1]?.options.reasoningEffort).toBeUndefined();
		expect(captured[1]?.options.maxRetries).toBe(0);
	});

	it("does not fall back to a text-only model when the conversation has images", async () => {
		const primarySource = model("anthropic", "primary");
		const textOnlySource = model("openai", "fallback", ["text"]);
		const { runtime, captured } = makeRuntime(primarySource, [() => eventStream([errorEvent("primary failed")])], {
			getModels: () => [primarySource, textOnlySource],
			getModel: (provider, id) => (provider === "openai" && id === "fallback" ? textOnlySource : undefined),
			isUsingOAuth: () => false,
		});

		const events: AssistantMessageEvent[] = [];
		for await (const event of await streamInternalModel(
			runtime,
			primarySource,
			imageContext(),
			{},
			{ settings: settingsFor({ "anthropic/primary": ["openai/fallback"] }), agentDir },
		)) {
			events.push(event);
		}

		expect(events.some((event) => event.type === "error")).toBe(true);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.model.id).toBe("primary");
	});
});
