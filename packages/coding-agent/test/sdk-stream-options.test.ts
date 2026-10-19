import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	type Model,
	normalizeContext,
	type ProviderRequestProvenance,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { KIMI_CODE_RETRY_PROFILE } from "@earendil-works/pi-ai/utils/retry-profile/profiles";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession stream options", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-stream-options-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(api: Api): Model<Api> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			headers: { "x-model": "model" },
		};
	}

	function createDoneMessage(api: Api): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api,
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function createDoneStream(api: Api) {
		const stream = createAssistantMessageEventStream();
		const message = createDoneMessage(api);
		stream.end(message);
		return { stream, message };
	}

	async function captureStreamOptions(
		api: Api,
		settings: Partial<Settings>,
		requestOptions: SimpleStreamOptions = {},
		extensionFactory?: ExtensionFactory,
		retryPolicy?: typeof KIMI_CODE_RETRY_PROFILE,
		providerEvent?: unknown,
	): Promise<SimpleStreamOptions | undefined> {
		const model = createModel(api);
		const settingsManager = SettingsManager.inMemory(settings);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: extensionFactory ? [extensionFactory] : [],
		});
		await resourceLoader.reload();

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api,
			headers: { "x-provider": "provider" },
			...(retryPolicy !== undefined ? { retryPolicy } : {}),
			streamSimple: (requestModel, _context, providerOptions) => {
				capturedOptions = providerOptions;
				if (providerEvent === undefined) return createDoneStream(api).stream;

				const stream = createAssistantMessageEventStream();
				void (async () => {
					await providerOptions?.onProviderStreamEvent?.(providerEvent, requestModel);
					stream.end(createDoneMessage(api));
				})();
				return stream;
			},
		});

		const modelRuntime = getModelRuntime(modelRegistry);
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		try {
			if (providerEvent === undefined) {
				const stream = await session.agent.streamFunction(
					model,
					normalizeContext({ messages: [] }),
					requestOptions,
				);
				await stream.result();
			} else {
				await session.prompt("test");
			}
			return capturedOptions;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	async function captureAgentIdleTimeout(settings: {
		httpIdleTimeoutMs?: number;
		retry?: { provider?: { timeoutMs?: number } };
	}): Promise<number | undefined> {
		const model = createModel("openai-completions");
		const settingsManager = SettingsManager.inMemory(settings);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const sessionManager = SessionManager.inMemory(cwd);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager,
		});

		try {
			return session.agent.timeoutMs;
		} finally {
			session.dispose();
		}
	}

	it("enables the agent stream idle timeout by default", async () => {
		expect(await captureAgentIdleTimeout({})).toBe(300_000);
	});

	it("follows httpIdleTimeoutMs for the agent stream idle timeout", async () => {
		expect(await captureAgentIdleTimeout({ httpIdleTimeoutMs: 60_000 })).toBe(60_000);
	});

	it("disables the agent stream idle timeout when httpIdleTimeoutMs is 0", async () => {
		expect(await captureAgentIdleTimeout({ httpIdleTimeoutMs: 0 })).toBeUndefined();
	});

	it("prefers retry.provider.timeoutMs for the agent stream idle timeout", async () => {
		expect(await captureAgentIdleTimeout({ httpIdleTimeoutMs: 0, retry: { provider: { timeoutMs: 5_000 } } })).toBe(
			5_000,
		);
	});

	it("forwards httpIdleTimeoutMs as timeoutMs for ChatGPT Subscription", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("defaults timeoutMs from httpIdleTimeoutMs for all providers", async () => {
		const options = await captureStreamOptions("openai-completions", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("lets request timeoutMs override httpIdleTimeoutMs for ChatGPT Subscription", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ httpIdleTimeoutMs: 1234 },
			{ timeoutMs: 0 },
		);

		expect(options?.timeoutMs).toBe(0);
	});

	it("forwards websocketConnectTimeoutMs from settings", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { websocketConnectTimeoutMs: 1234 });

		expect(options?.websocketConnectTimeoutMs).toBe(1234);
	});

	it("lets request websocketConnectTimeoutMs override settings", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ websocketConnectTimeoutMs: 1234 },
			{ websocketConnectTimeoutMs: 0 },
		);

		expect(options?.websocketConnectTimeoutMs).toBe(0);
	});

	it("forwards provider retry settings", async () => {
		const options = await captureStreamOptions("openai-completions", {
			retry: { provider: { maxRetries: 2, maxRetryDelayMs: 3000 } },
		});

		expect(options?.maxRetries).toBe(2);
		expect(options?.maxRetryDelayMs).toBe(3000);
	});

	it("a declared profile with a disabled providerRequest stage sends zero transport retries", async () => {
		// The kimi-code profile disables the transport stage so user
		// retry.provider.maxRetries cannot hand it a hidden second budget on top
		// of the turn stage's own 9.
		const options = await captureStreamOptions(
			"anthropic-messages",
			{ retry: { provider: { maxRetries: 2, maxRetryDelayMs: 3000 } } },
			{},
			undefined,
			KIMI_CODE_RETRY_PROFILE,
		);

		expect(options?.maxRetries).toBe(0);
		expect(options?.maxRetryDelayMs).toBe(3000);
	});

	// Regression test for #9784.
	it("forwards provider stream events to extensions", async () => {
		const providerEvent = { openrouter_metadata: { strategy: "direct" } };
		const extensionEvents: unknown[] = [];

		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{},
			(pi) => {
				pi.on("provider_stream_event", (event) => {
					extensionEvents.push(event);
				});
			},
			undefined,
			providerEvent,
		);

		expect(options?.onProviderStreamEvent).toEqual(expect.any(Function));
		expect(extensionEvents).toEqual([
			{
				data: providerEvent,
				type: "provider_stream_event",
				provider: "capture-provider",
				api: "openai-completions",
				model: "capture-model",
				provenance: {
					requestId: expect.any(String),
					attemptId: expect.any(String),
					failoverIndex: 0,
				},
			},
		]);
	});

	it("runs before_provider_headers on assembled headers without forwarding the transform", async () => {
		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{ headers: { "x-explicit": "explicit" } },
			(pi) => {
				pi.on("before_provider_headers", (event) => {
					event.headers["x-hook"] = [
						event.headers["x-provider"],
						event.headers["x-model"],
						event.headers["x-explicit"],
					].join(":");
				});
			},
		);

		expect(options?.headers).toMatchObject({
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-hook": "provider:model:explicit",
		});
		expect(options).not.toHaveProperty("transformHeaders");
	});

	it("ordinary AgentSession streamSimple turns fail over pooled credentials", async () => {
		const model = createModel("openai-completions");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({
			type: "api_key",
			key: "one",
			accounts: [
				{ name: "one", key: "one" },
				{ name: "two", key: "two" },
			],
		}));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		const attempts: string[] = [];
		const hooks: { type: string; provenance: ProviderRequestProvenance | undefined }[] = [];
		const attemptEvents: ProviderRequestProvenance[] = [];
		const responses: unknown[] = [];
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			extensionFactories: [
				(pi) => {
					pi.on("provider_request_attempt", (event) => {
						attemptEvents.push(event.provenance);
					});
					const record = (event: { type: string; provenance?: ProviderRequestProvenance }) => {
						hooks.push({ type: event.type, provenance: event.provenance });
					};
					pi.on("before_provider_headers", record);
					pi.on("before_provider_request", record);
					pi.on("after_provider_response", record);
					pi.on("provider_stream_event", (event) => {
						record(event);
						responses.push(event.data);
					});
				},
			],
		});
		await resourceLoader.reload();
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (_model, _context, options) => {
				attempts.push(options?.apiKey ?? "missing");
				const stream = createAssistantMessageEventStream();
				const startEvent = {
					type: "start",
					partial: {
						role: "assistant",
						content: [],
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
						timestamp: Date.now(),
					},
				} satisfies AssistantMessageEvent;
				const attempt = attempts.length;
				// Real providers emit events after the stream is returned and finish
				// with a terminal "done" event; the runtime derives the final message
				// from that event, never from a bare end() call.
				const { message } = createDoneStream(model.api);
				void (async () => {
					await options?.onPayload?.({ model: model.id }, model);
					await options?.onResponse?.({ status: attempt === 1 ? 401 : 200, headers: {} }, model);
					await options?.onProviderStreamEvent?.({ response: { id: `response-${attempt}` } }, model);
					stream.push(structuredClone(startEvent));
					if (attempt === 1) {
						stream.push({
							type: "error",
							reason: "error",
							error: { ...message, stopReason: "error", errorMessage: "401 unauthorized" },
						});
					} else {
						stream.push({ type: "done", reason: "stop", message });
					}
				})();
				return stream;
			},
		});
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader,
			settingsManager: SettingsManager.inMemory({}),
			sessionManager,
			// The explicit fixture model does not need model-picker discovery.
			scopedModels: [],
			favoriteModels: [],
		});
		try {
			await session.prompt("hello");
		} finally {
			session.dispose();
		}
		expect(attempts).toHaveLength(2);
		expect(new Set(attempts).size).toBe(2);
		expect(hooks.map((hook) => hook.type)).toEqual(
			Array.from({ length: 2 }, () => [
				"before_provider_headers",
				"before_provider_request",
				"after_provider_response",
				"provider_stream_event",
			]).flat(),
		);
		const first = hooks[0].provenance;
		const second = hooks[4].provenance;
		expect(first).toEqual({
			requestId: expect.any(String),
			attemptId: expect.any(String),
			failoverIndex: 0,
			slot: { lane: "stored", name: attempts[0] },
		});
		expect(second).toEqual({
			requestId: first?.requestId,
			attemptId: expect.any(String),
			failoverIndex: 1,
			slot: { lane: "stored", name: attempts[1] },
		});
		expect(second?.attemptId).not.toBe(first?.attemptId);
		for (const [index, hook] of hooks.entries()) {
			expect(hook.provenance).toBe(index < 4 ? first : second);
			expect(Object.isFrozen(hook.provenance)).toBe(true);
			expect(Object.isFrozen(hook.provenance?.slot)).toBe(true);
		}
		expect(responses).toEqual([{ response: { id: "response-1" } }, { response: { id: "response-2" } }]);
		expect(attemptEvents).toEqual([first, second]);
		expect(
			sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "senpi.provider-request-attempt"),
		).toMatchObject([
			{ data: { provider: model.provider, model: model.id, provenance: first } },
			{ data: { provider: model.provider, model: model.id, provenance: second } },
		]);
		const finalMessage = session.messages.at(-1);
		expect(finalMessage).toMatchObject({ role: "assistant", requestProvenance: second });
	});
});
