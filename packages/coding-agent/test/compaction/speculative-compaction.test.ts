import {
	type FauxModelDefinition,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import {
	type Context,
	createAssistantMessageEventStream,
	type Model,
	registerApiProvider,
	type StreamOptions,
	unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import { shouldStartSpeculativeCompaction } from "../../src/core/extensions/builtin/compaction/policy.ts";
import {
	applyGeneratedCompaction,
	applySpeculativeCompaction,
	createSpeculativeCompactionSnapshot,
	runExtensionCompaction,
	type SpeculativeCompactionContext,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness } from "../suite/harness.ts";

const registrations: Array<{ unregister: () => void }> = [];

type Registration = ReturnType<typeof registerFauxProvider>;
type TestSpeculativeCompactionContext = SpeculativeCompactionContext & {
	registration: Registration;
	sessionManager: SessionManager;
};

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function createContext(options?: {
	revision?: number;
	models?: FauxModelDefinition[];
	withAuth?: boolean;
	shrink?: boolean;
}): TestSpeculativeCompactionContext {
	const withAuth = options?.withAuth ?? true;
	const registration = registerFauxProvider(options?.models ? { models: options.models } : {});
	registrations.push(registration);
	const model = registration.getModel();
	const authStorage = AuthStorage.inMemory();
	if (withAuth) {
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
	}
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		...(withAuth ? { apiKey: "faux-key" } : {}),
		api: registration.api,
		models: registration.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});
	const sessionManager = SessionManager.inMemory();
	const historyRepeat = options?.shrink ? 120 : 12_000;
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "first user ".repeat(historyRepeat) }],
		timestamp: Date.now() - 3_000,
	});
	sessionManager.appendMessage({
		...fauxAssistantMessage("first assistant ".repeat(historyRepeat), { timestamp: Date.now() - 2_000 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 50_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 50_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "second user ".repeat(12_000) }],
		timestamp: Date.now() - 1_000,
	});

	return {
		model,
		modelRegistry,
		registration,
		sessionManager,
		getContextUsage: () => ({ tokens: 50_000, contextWindow: model.contextWindow, percent: 25 }),
		getMessageRevision: () => options?.revision ?? 1,
		applyCompaction: async () => ({ applied: true, reason: "ok" }),
	};
}

describe("speculative compaction", () => {
	it("starts at the 37.5 percent default trigger for a 32k context window", () => {
		// Given
		const contextWindow = 32_000;

		// When
		const beforeTrigger = shouldStartSpeculativeCompaction(
			{ tokens: 11_999, contextWindow, percent: null },
			contextWindow,
			DEFAULT_COMPACTION_SETTINGS,
		);
		const atTrigger = shouldStartSpeculativeCompaction(
			{ tokens: 12_000, contextWindow, percent: null },
			contextWindow,
			DEFAULT_COMPACTION_SETTINGS,
		);

		// Then
		expect(beforeTrigger).toBe(false);
		expect(atTrigger).toBe(true);
	});

	it("uses the synchronously captured preparation when the session changes before generation", () => {
		// Given
		const context = createContext();
		// When
		const snapshot = createSpeculativeCompactionSnapshot(context, {
			customInstructions: "Proactively compact before the next agent turn.",
			generation: 1,
		});
		context.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "late mutation" }],
			timestamp: Date.now(),
		});
		const lateEntryId = context.sessionManager.getEntries()[context.sessionManager.getEntries().length - 1]?.id;

		// Then
		expect(snapshot?.expectedRevision).toBe(1);
		expect(snapshot?.preparation.firstKeptEntryId).toBeDefined();
		expect(snapshot?.preparation.firstKeptEntryId).not.toBe(lateEntryId);
	});

	it("skips applyCompaction when message revision changes while the summary is in flight", async () => {
		// Given
		let revision = 1;
		const context = createContext({ revision });
		context.getMessageRevision = () => revision;
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		const appliedSummaries: string[] = [];
		context.applyCompaction = async (precomputed) => {
			appliedSummaries.push(precomputed.summary);
			return { applied: true, reason: "ok" };
		};
		revision = 2;

		// When
		const result = await applySpeculativeCompaction(
			context,
			snapshot,
			() => 1,
			async () => ({
				summary: "generated summary",
				firstKeptEntryId: snapshot?.preparation.firstKeptEntryId ?? "missing",
				tokensBefore: snapshot?.preparation.tokensBefore ?? 0,
			}),
		);

		// Then
		expect(result).toEqual({ applied: false, reason: "stale" });
		expect(appliedSummaries).toHaveLength(0);
	});

	it("skips applyCompaction when a newer speculative generation starts before apply", async () => {
		// Given
		const context = createContext();
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		const appliedSummaries: string[] = [];
		context.applyCompaction = async (precomputed) => {
			appliedSummaries.push(precomputed.summary);
			return { applied: true, reason: "ok" };
		};

		// When
		const result = await applySpeculativeCompaction(
			context,
			snapshot,
			() => 2,
			async () => ({
				summary: "generated summary",
				firstKeptEntryId: snapshot?.preparation.firstKeptEntryId ?? "missing",
				tokensBefore: snapshot?.preparation.tokensBefore ?? 0,
			}),
		);

		// Then
		expect(result).toEqual({ applied: false, reason: "stale" });
		expect(appliedSummaries).toHaveLength(0);
	});

	it("applies a completed speculative summary on the next blocking threshold", async () => {
		// Given
		const context = createContext();
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		const appliedOptions: Array<{ reason: string; expectedRevision?: number }> = [];
		context.applyCompaction = async (_precomputed, options) => {
			appliedOptions.push(options);
			return { applied: true, reason: "ok" };
		};

		// When
		const result = await applyGeneratedCompaction(context, snapshot, () => 1, {
			summary: "completed speculative summary",
			firstKeptEntryId: snapshot?.preparation.firstKeptEntryId ?? "missing",
			tokensBefore: snapshot?.preparation.tokensBefore ?? 0,
		});

		// Then
		expect(result).toEqual({ applied: true, reason: "ok" });
		expect(appliedOptions).toEqual([{ reason: "extension", expectedRevision: 1 }]);
	});

	it("returns unavailable when manual compaction aborts in-flight speculative generation", async () => {
		// Given
		const context = createContext();
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		const controller = new AbortController();
		controller.abort();

		// When
		const result = snapshot ? await runExtensionCompaction(context, snapshot, controller.signal) : undefined;

		// Then
		expect(result).toBeUndefined();
	});

	it("runs the non-remote summarizer through the final extension request pipeline", async () => {
		const api = `compaction-stream-${Math.random().toString(36).slice(2)}`;
		const provider = `compaction-provider-${Math.random().toString(36).slice(2)}`;
		const sourceId = `compaction-stream-capture-${api}`;
		const rawSecret = "STREAM_COMPACTION_RAW_SECRET";
		const redactedSecret = "STREAM_COMPACTION_REDACTED";
		const stages: string[] = [];
		let captured: { context: Context; payload: unknown; headers: StreamOptions["headers"] | undefined } | undefined;
		const captureStream = (model: Model<typeof api>, context: Context, options?: StreamOptions) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				void (async () => {
					const initialPayload = { system: context.systemPrompt, messages: context.messages };
					const payload = (await options?.onPayload?.(initialPayload, model)) ?? initialPayload;
					captured = { context, payload, headers: options?.headers ? { ...options.headers } : undefined };
					stages.push("provider");
					const message = fauxAssistantMessage("stream summary");
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
				})().catch((error) => {
					const message = fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: error instanceof Error ? error.message : String(error),
					});
					stream.push({ type: "error", reason: "error", error: message });
					stream.end(message);
				});
			});
			return stream;
		};

		const harness = await createHarness({
			api,
			provider,
			models: [{ id: "stream-compact", contextWindow: 32_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [
				compactionExtension,
				(pi) => {
					pi.on("context", (event) => {
						stages.push("context-redact");
						return {
							messages: event.messages.map((message) => {
								if (message.role !== "user" || typeof message.content === "string") return message;
								return {
									...message,
									content: message.content.map((part) =>
										part.type === "text"
											? { ...part, text: part.text.replaceAll(rawSecret, redactedSecret) }
											: part,
									),
								};
							}),
						};
					});
					pi.on("context", () => {
						stages.push("context-final");
					});
					pi.on("before_provider_request", (event) => {
						stages.push("payload");
						return { ...(event.payload as Record<string, unknown>), extension_request_hook: "applied" };
					});
					pi.on("before_provider_headers", (event) => {
						stages.push("headers");
						event.headers["x-compaction-request-hook"] = "applied";
					});
				},
			],
		});

		harness.faux.unregister();
		registerApiProvider({ api, stream: captureStream, streamSimple: captureStream }, sourceId);
		try {
			await harness.session.bindExtensions({});
			const model = harness.getModel();
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `persisted ${rawSecret}` }],
				timestamp: 1,
			});
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage("persisted assistant"),
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: 2,
			});
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "retain this turn" }],
				timestamp: 3,
			});
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

			await harness.session.compact();

			expect(JSON.stringify(harness.sessionManager.getEntries())).toContain(rawSecret);
			expect(captured).toBeDefined();
			const capturedSecretMessage = captured?.context.messages.find(
				(message) =>
					message.role === "user" &&
					typeof message.content !== "string" &&
					message.content.some((part) => part.type === "text" && part.text.includes("persisted")),
			);
			const capturedSecretText =
				capturedSecretMessage?.role === "user" && Array.isArray(capturedSecretMessage.content)
					? capturedSecretMessage.content
							.filter((part): part is { type: "text"; text: string } => part.type === "text")
							.map((part) => part.text)
							.join("\n")
					: "";
			expect(capturedSecretText).toContain(redactedSecret);
			expect(capturedSecretText).not.toContain(rawSecret);
			expect(captured?.payload).toMatchObject({ extension_request_hook: "applied" });
			expect(captured?.headers?.["x-compaction-request-hook"]).toBe("applied");
			for (const stage of ["context-redact", "context-final", "payload", "headers"]) {
				expect(stages.indexOf(stage)).toBeGreaterThanOrEqual(0);
				expect(stages.indexOf(stage)).toBeLessThan(stages.indexOf("provider"));
			}
			expect(stages.indexOf("context-redact")).toBeLessThan(stages.indexOf("context-final"));
		} finally {
			unregisterApiProviders(sourceId);
			harness.cleanup();
		}
	});

	it("redacts a persisted custom message via raw-message context hooks before the non-remote summarizer stream", async () => {
		const api = `compaction-stream-${Math.random().toString(36).slice(2)}`;
		const provider = `compaction-provider-${Math.random().toString(36).slice(2)}`;
		const sourceId = `compaction-stream-capture-${api}`;
		const rawSecret = "PERSISTED_CUSTOM_RAW_SECRET";
		const redactedSecret = "[redacted persisted custom secret]";
		let contextHookRan = false;
		let hookSawRawCustomSecret = false;
		let captured: Context | undefined;
		const captureStream = (_model: Model<typeof api>, context: Context, _options?: StreamOptions) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				captured = context;
				const message = fauxAssistantMessage("stream summary");
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		};

		const harness = await createHarness({
			api,
			provider,
			models: [{ id: "stream-compact", contextWindow: 32_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [
				compactionExtension,
				(pi) => {
					pi.on("context", (event) => {
						contextHookRan = true;
						return {
							messages: event.messages.map((message) => {
								if (message.role !== "custom" || message.customType !== "secret") return message;
								hookSawRawCustomSecret = true;
								return { ...message, content: redactedSecret };
							}),
						};
					});
				},
			],
		});

		harness.faux.unregister();
		registerApiProvider({ api, stream: captureStream, streamSimple: captureStream }, sourceId);
		try {
			await harness.session.bindExtensions({});
			const model = harness.getModel();
			harness.sessionManager.appendCustomMessageEntry(
				"secret",
				[{ type: "text", text: `persisted ${rawSecret}` }],
				false,
			);
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage("persisted assistant"),
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: 2,
			});
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "retain this turn" }],
				timestamp: 3,
			});
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

			await harness.session.compact();

			// The raw session keeps the persisted secret untouched; only the
			// outgoing summarization stream input is redacted.
			expect(JSON.stringify(harness.sessionManager.getEntries())).toContain(rawSecret);
			expect(contextHookRan).toBe(true);
			// Ordered context hooks must run on the raw AgentMessage list, before
			// convertToLlm/repair erases role + customType.
			expect(hookSawRawCustomSecret).toBe(true);
			expect(captured).toBeDefined();
			const capturedText = JSON.stringify(captured?.messages);
			expect(capturedText).toContain(redactedSecret);
			expect(capturedText).not.toContain(rawSecret);
		} finally {
			unregisterApiProviders(sourceId);
			harness.cleanup();
		}
	});

	it("streams generated summary deltas to the compaction progress callback", async () => {
		// Given
		const context = createContext();
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		const deltas: string[] = [];
		context.registration.setResponses([fauxAssistantMessage("live summary")]);

		// When
		const result = snapshot
			? await runExtensionCompaction(context, snapshot, undefined, (delta) => {
					deltas.push(delta);
				})
			: undefined;

		// Then
		expect(result?.summary).toBe("live summary");
		expect(deltas.join("")).toBe("live summary");
	});

	it("retries a compaction summary request with a smaller input after a context-window failure", async () => {
		// Given
		const context = createContext();
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		context.registration.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage:
					"Your input exceeds the context window of this model. Please adjust your input and try again.",
			}),
			fauxAssistantMessage("retry summary"),
		]);

		// When
		const result = snapshot ? await runExtensionCompaction(context, snapshot) : undefined;

		// Then
		expect(result?.summary).toBe("retry summary");
		expect(context.registration.getCallLog()).toHaveLength(2);
	});

	it("keeps pruning and retrying after repeated compaction summary context-window failures", async () => {
		// Given
		const context = createContext();
		context.getCompactionSettings = () => ({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 });
		context.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept recent user" }],
			timestamp: Date.now(),
		});
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		context.registration.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage:
					"Your input exceeds the context window of this model. Please adjust your input and try again.",
			}),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage:
					"Your input exceeds the context window of this model. Please adjust your input and try again.",
			}),
			fauxAssistantMessage("eventually compacted"),
		]);

		// When
		const result = snapshot ? await runExtensionCompaction(context, snapshot) : undefined;

		// Then
		expect(result?.summary).toBe("eventually compacted");
		const requestTexts = context.registration.getCallLog().map((entry) => {
			const firstMessage = entry.context.messages[0];
			if (!firstMessage) return "";
			const content = firstMessage.content;
			if (typeof content === "string") return content;
			return content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
		});
		expect(requestTexts).toHaveLength(3);
		expect(requestTexts[0]).toContain("first user");
		expect(requestTexts[1]).not.toContain("first user");
		expect(requestTexts[1]).toContain("first assistant");
		expect(requestTexts[2]).not.toContain("first assistant");
		expect(requestTexts[2]).toContain("second user");
		expect(requestTexts[2]).not.toContain("kept recent user");
	});

	it("sends the conversation as native messages with a trailing summarization instruction", async () => {
		// Given
		const context = createContext();
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		context.registration.setResponses([fauxAssistantMessage("native summary")]);

		// When
		const result = snapshot ? await runExtensionCompaction(context, snapshot) : undefined;

		// Then
		expect(result?.summary).toBe("native summary");
		const call = context.registration.getCallLog()[0];
		expect(call).toBeDefined();
		if (!call) throw new Error("expected a summarization request");
		// Conversation travels as native messages, not one serialized dump.
		expect(call.context.messages.length).toBeGreaterThan(1);
		const firstText = messageText(call.context.messages[0]);
		expect(firstText).toContain("first user");
		expect(firstText).not.toContain("<conversation>");
		const lastMessage = call.context.messages[call.context.messages.length - 1];
		expect(lastMessage?.role).toBe("user");
		expect(messageText(lastMessage)).toContain("[INTERNAL COMPACTION INSTRUCTION");
	});

	it("passes the agent system prompt and tools to the summarization request", async () => {
		// Given
		const context = createContext();
		context.getSystemPrompt = () => "AGENT SYSTEM PROMPT";
		const tools = [
			{
				name: "read",
				description: "Read a file",
				parameters: { type: "object", properties: {} },
			},
		];
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1, tools });
		context.registration.setResponses([fauxAssistantMessage("with tools")]);

		// When
		const result = snapshot ? await runExtensionCompaction(context, snapshot) : undefined;

		// Then
		expect(result?.summary).toBe("with tools");
		const call = context.registration.getCallLog()[0];
		expect(call?.context.systemPrompt).toBe("AGENT SYSTEM PROMPT");
		expect(call?.context.tools?.map((tool) => tool.name)).toEqual(["read"]);
	});

	it("throws the provider error when the summarization request fails", async () => {
		// Given
		const context = createContext();
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		context.registration.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "faux: request blocked by provider policy",
			}),
		]);

		// When / Then
		await expect(snapshot ? runExtensionCompaction(context, snapshot) : undefined).rejects.toThrow(
			"request blocked by provider policy",
		);
	});

	it("returns undefined when the summarization stream is aborted", async () => {
		// Given
		const context = createContext();
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		context.registration.setResponses([
			fauxAssistantMessage("partial summary before abort", { stopReason: "aborted" }),
		]);

		// When
		const result = snapshot ? await runExtensionCompaction(context, snapshot) : undefined;

		// Then
		expect(result).toBeUndefined();
	});

	it("does not reject a successful summary because the summarized input was large", async () => {
		// Given: summarized input (~86k tokens) is far above 60% of the window
		// (100k * 0.6 = 60k) while still fitting in the window itself.
		const context = createContext();
		const window = 100_000;
		context.getContextUsage = () => ({ tokens: 86_000, contextWindow: window, percent: 86 });
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		context.registration.setResponses([fauxAssistantMessage("large-input summary")]);

		// When
		const result = snapshot ? await runExtensionCompaction(context, snapshot) : undefined;

		// Then
		expect(result?.summary).toBe("large-input summary");
	});

	it("rejects with a typed empty-summary error naming the stop reason", async () => {
		// Given: adaptive-thinking models can burn the whole output budget on
		// thinking and end at the cap with no text blocks at all.
		const context = createContext();
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		context.registration.setResponses([
			fauxAssistantMessage([fauxThinking("all budget spent thinking")], { stopReason: "length" }),
		]);

		// When
		let caught: unknown;
		try {
			if (!snapshot) throw new Error("expected snapshot");
			await runExtensionCompaction(context, snapshot);
		} catch (error) {
			caught = error;
		}

		// Then
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).name).toBe("SummaryGenerationError");
		expect((caught as { kind?: string }).kind).toBe("empty-summary");
		expect((caught as Error).message).toContain("stopReason: length");
	});

	it("rejects with an empty-summary error when the model answers with a bare tool call", async () => {
		// Given: the summarization request forwards the agent's tools, so a model
		// can hijack the request and respond with a tool call instead of text.
		const context = createContext();
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		context.registration.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "/tmp/x" })], { stopReason: "toolUse" }),
		]);

		// When
		let caught: unknown;
		try {
			if (!snapshot) throw new Error("expected snapshot");
			await runExtensionCompaction(context, snapshot);
		} catch (error) {
			caught = error;
		}

		// Then
		expect((caught as Error | undefined)?.name).toBe("SummaryGenerationError");
		expect((caught as Error | undefined)?.message).toContain("stopReason: toolUse");
	});

	it("rejects with a typed auth error when credentials cannot be resolved", async () => {
		// Given
		const context = createContext({ withAuth: false });
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		context.registration.setResponses([fauxAssistantMessage("never reached")]);

		// When
		let caught: unknown;
		try {
			if (!snapshot) throw new Error("expected snapshot");
			await runExtensionCompaction(context, snapshot);
		} catch (error) {
			caught = error;
		}

		// Then
		expect((caught as Error | undefined)?.name).toBe("SummaryGenerationError");
		expect((caught as { kind?: string } | undefined)?.kind).toBe("auth");
		expect((caught as Error | undefined)?.message).toContain("credentials unavailable");
	});

	it("caps the summarization request tokens at the model maximum", async () => {
		// Given: the default faux model advertises maxTokens 16384, below the
		// summary headroom, so the request must use the model cap.
		const context = createContext();
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		context.registration.setResponses([fauxAssistantMessage("capped summary")]);

		// When
		const result = snapshot ? await runExtensionCompaction(context, snapshot) : undefined;

		// Then
		expect(result?.summary).toBe("capped summary");
		const call = context.registration.getCallLog()[0];
		expect(call?.options?.maxTokens).toBe(16_384);
	});

	it("grants summarization headroom above the legacy 8k cap for large-output models", async () => {
		// Given: thinking models emit reasoning tokens before the summary text,
		// so an 8192-token cap can starve the text entirely. Large-output models
		// get the full 32k headroom.
		const context = createContext({
			models: [{ id: "faux-large", contextWindow: 200_000, maxTokens: 131_072 }],
		});
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		context.registration.setResponses([fauxAssistantMessage("roomy summary")]);

		// When
		const result = snapshot ? await runExtensionCompaction(context, snapshot) : undefined;

		// Then
		expect(result?.summary).toBe("roomy summary");
		const call = context.registration.getCallLog()[0];
		expect(call?.options?.maxTokens).toBe(32_768);
	});

	it("leaves half the context window for input when the model advertises no separate output cap", async () => {
		// Given: some providers enforce input + max_tokens <= contextWindow
		// (catalog models with contextWindow == maxTokens, e.g. small OpenRouter
		// models); reserving the whole window for output makes every
		// summarization request invalid. keepRecentTokens shrinks to the window's
		// keep cap (0.3*32768), so the prepared history must be tiny.
		const context = createContext({
			models: [{ id: "faux-tight", contextWindow: 32_768, maxTokens: 32_768 }],
			shrink: true,
		});
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		context.registration.setResponses([fauxAssistantMessage("tight summary")]);

		// When
		const result = snapshot ? await runExtensionCompaction(context, snapshot) : undefined;

		// Then
		expect(result?.summary).toBe("tight summary");
		const call = context.registration.getCallLog()[0];
		expect(call?.options?.maxTokens).toBeLessThanOrEqual(Math.floor(32_768 / 2));
	});

	it("treats a pre-aborted signal as an abort even when credentials are unavailable", async () => {
		// Given: abort must take precedence over failure diagnosis — the user
		// cancelling a compaction must never read as a credential error.
		const context = createContext({ withAuth: false });
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		if (!snapshot) throw new Error("expected snapshot");
		const controller = new AbortController();
		controller.abort();

		// When
		const result = await runExtensionCompaction(context, snapshot, controller.signal);

		// Then
		expect(result).toBeUndefined();
	});
});

function messageText(message: { content: unknown } | undefined): string {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		if (!("type" in part) || part.type !== "text") continue;
		if (!("text" in part) || typeof part.text !== "string") continue;
		texts.push(part.text);
	}
	return texts.join("\n");
}
