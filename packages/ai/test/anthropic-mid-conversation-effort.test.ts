import { describe, expect, it } from "vitest";
import { stream } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

interface WireMessage {
	role: string;
	content: unknown;
	output_config?: { effort?: string };
}

interface CapturedPayload {
	messages: WireMessage[];
	thinking?: {
		type: string;
		display?: string;
		block_binding?: { prefix_mismatch_behavior?: string };
	};
	output_config?: { effort?: string };
	fallbacks?: Array<{ model: string }>;
}

function managedModel(provider = "anthropic"): Model<"anthropic-messages"> {
	return {
		id: "claude-fable-5-1",
		name: "Claude Fable 5.1",
		api: "anthropic-messages",
		provider,
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", max: "max" },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true },
	};
}

function assistant(model: Model<"anthropic-messages">, level?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "reasoning", thinkingSignature: "signature" },
			{ type: "text", text: "answer" },
		],
		api: "anthropic-messages",
		provider: model.provider,
		model: model.id,
		...(level === undefined ? {} : { providerThinkingLevel: level }),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

async function capture(
	model: Model<"anthropic-messages">,
	context: Context,
	effort?: "low" | "medium" | "high" | "xhigh" | "max",
): Promise<{ payload: CapturedPayload; message: AssistantMessage }> {
	let payload: CapturedPayload | undefined;
	const result = stream(model, normalizeContext(context), {
		apiKey: "test-key",
		cacheRetention: "none",
		thinkingEnabled: true,
		effort,
		onPayload: (value) => {
			payload = value as CapturedPayload;
			throw new Error("payload captured");
		},
	});
	const message = await result.result();
	if (!payload) throw new Error("Expected payload capture");
	return { payload, message };
}

const user = (text: string, timestamp: number) => ({ role: "user" as const, content: text, timestamp });

const SSE_OK = [
	{ type: "message_start", message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } } },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 1 } },
	{ type: "message_stop" },
]
	.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("");

async function captureWire(
	model: Model<"anthropic-messages">,
	context: Context,
	effort: "low" | "medium" | "high" | "xhigh" | "max" | undefined,
	thinkingEnabled = true,
): Promise<{ wire: CapturedPayload; message: AssistantMessage }> {
	let wire: CapturedPayload | undefined;
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		wire = (await request.json()) as CapturedPayload;
		return new Response(SSE_OK, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const message = await stream({ ...model, baseUrl: "http://127.0.0.1:9" }, normalizeContext(context), {
		apiKey: "test-key",
		cacheRetention: "none",
		thinkingEnabled,
		effort,
		fetch: fetchImpl,
	}).result();
	if (!wire) throw new Error("Expected the request body to reach fetch");
	return { wire, message };
}

function effortMessages(payload: CapturedPayload): WireMessage[] {
	return payload.messages.filter((message) => message.role === "system");
}

describe("Anthropic mid-conversation effort", () => {
	it("reconstructs an exact historical marker prefix and appends the current marker", async () => {
		const model = managedModel();
		const first = await capture(model, { messages: [user("one", 1)] }, "low");
		const second = await capture(
			model,
			{ messages: [user("one", 1), assistant(model, "low"), user("two", 2)] },
			"high",
		);

		expect(first.payload.messages).toEqual([
			{ role: "user", content: "one" },
			{ role: "system", content: [], output_config: { effort: "low" } },
		]);
		expect(second.payload.messages.slice(0, first.payload.messages.length)).toEqual(first.payload.messages);
		expect(second.payload.messages.at(-1)).toEqual({
			role: "system",
			content: [],
			output_config: { effort: "high" },
		});
		expect(first.payload.output_config).toEqual({ effort: "high" });
		expect(second.payload.output_config).toEqual({ effort: "high" });
		expect(second.payload.thinking).toEqual({
			type: "adaptive",
			display: "summarized",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		});
		expect(first.message.providerThinkingLevel).toBe("low");
	});

	it.each(["low", "medium", "high", "xhigh", "max"] as const)("preserves native effort %s", async (effort) => {
		const model = managedModel();
		const { payload, message } = await capture(model, { messages: [user("one", 1)] }, effort);
		expect(effortMessages(payload)).toEqual([{ role: "system", content: [], output_config: { effort } }]);
		expect(message.providerThinkingLevel).toBe(effort);
	});

	it("defaults omitted effort to high and still enables drop_block", async () => {
		const { payload, message } = await capture(managedModel(), { messages: [user("one", 1)] });
		expect(payload.messages.at(-1)).toEqual({
			role: "system",
			content: [],
			output_config: { effort: "high" },
		});
		expect(payload.thinking?.block_binding?.prefix_mismatch_behavior).toBe("drop_block");
		expect(message.providerThinkingLevel).toBe("high");
	});

	it("does not invent markers for legacy or other-provider assistants", async () => {
		const model = managedModel();
		const legacy = assistant(model);
		const otherProvider = { ...assistant(model, "low"), provider: "other-provider" };
		const { payload } = await capture(
			model,
			{ messages: [user("one", 1), legacy, user("two", 2), otherProvider, user("three", 3)] },
			"medium",
		);
		expect(effortMessages(payload)).toEqual([{ role: "system", content: [], output_config: { effort: "medium" } }]);
	});

	it("leaves unsupported models on top-level effort", async () => {
		const model = managedModel();
		model.compat = { forceAdaptiveThinking: true };
		const { payload, message } = await capture(model, { messages: [user("one", 1)] }, "low");
		expect(payload.messages).toEqual([{ role: "user", content: "one" }]);
		expect(payload.output_config).toEqual({ effort: "low" });
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(message.providerThinkingLevel).toBeUndefined();
	});

	it("sends the effort and binding beta headers", async () => {
		let betaHeader: string | null = null;
		const events = [
			{
				type: "message_start",
				message: {
					id: "msg_test",
					model: "claude-fable-5-1",
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			{ type: "message_stop" },
		];
		const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
		const fetchImpl: typeof fetch = async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			betaHeader = request.headers.get("anthropic-beta");
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		const result = await stream(managedModel(), normalizeContext({ messages: [user("one", 1)] }), {
			apiKey: "test-key",
			cacheRetention: "none",
			fetch: fetchImpl,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(betaHeader).toContain("mid-conversation-output-config-2026-07-01");
		expect(betaHeader).toContain("thinking-binding-controls-2026-08-01");
	});

	// senpi#2957: a provider or route that configures its own anthropic-beta header must not drop the betas the
	// request body depends on. A proxy route with a custom header used to replace senpi's list, so Claude 5.5 models
	// 400ed on the first call ("messages.1.output_config: Extra inputs are not permitted").
	describe("a configured anthropic-beta header (senpi#2957)", () => {
		const PROXY_BETAS = "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14";
		const EFFORT = "mid-conversation-output-config-2026-07-01";
		const BINDING = "thinking-binding-controls-2026-08-01";
		const TOOL_CHANGES = "mid-conversation-tool-changes-2026-07-01";
		const FALLBACK = "server-side-fallback-2026-07-01";

		type WireBody = CapturedPayload & { fallbacks?: unknown; output_config?: unknown; tools?: unknown[] };

		async function wire(
			model: Model<"anthropic-messages">,
			options: {
				headers?: Record<string, string | null>;
				apiKey?: string;
				context?: Context;
				refusalFallbacks?: "default";
			} = {},
		) {
			const sent: { betas: string[]; body: WireBody }[] = [];
			const events = [
				{
					type: "message_start",
					message: { id: "msg_test", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } },
				},
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 1 } },
				{ type: "message_stop" },
			];
			const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
			const fetchImpl: typeof fetch = async (input, init) => {
				const request = input instanceof Request ? input : new Request(input, init);
				const header = request.headers.get("anthropic-beta") ?? "";
				sent.push({
					betas: header ? header.split(",").map((beta) => beta.trim()) : [],
					body: (await request.json()) as WireBody,
				});
				return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
			};
			const result = await stream(
				{ ...model, baseUrl: "http://127.0.0.1:9" },
				normalizeContext(options.context ?? { messages: [user("one", 1)] }),
				{
					apiKey: options.apiKey ?? "test-key",
					cacheRetention: "none",
					fetch: fetchImpl,
					...(options.headers ? { headers: options.headers } : {}),
					...(options.refusalFallbacks ? { refusalFallbacks: options.refusalFallbacks } : {}),
				},
			).result();
			return { result, request: sent[0], requests: sent.length };
		}

		const anthropicModel = (id: string, headers?: Record<string, string>): Model<"anthropic-messages"> => {
			const model = getModel("anthropic", id as "claude-haiku-5-5") as Model<"anthropic-messages">;
			return headers ? { ...model, headers } : model;
		};
		const toolContext: Context = {
			messages: [user("one", 1)],
			tools: [
				{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } as never },
			],
		};

		it("merges a model-level header with the effort and binding betas, configured order first, each once", async () => {
			const { result, request } = await wire(anthropicModel("claude-haiku-5-5", { "anthropic-beta": PROXY_BETAS }));
			expect(result.stopReason).toBe("stop");
			// Interleaved thinking is built into adaptive models and is stripped from the configured list.
			expect(request?.betas).toEqual(["fine-grained-tool-streaming-2025-05-14", EFFORT, BINDING]);
			expect(effortMessages(request?.body as CapturedPayload)).toEqual([
				{ role: "system", content: [], output_config: { effort: "high" } },
			]);
		});

		it("merges a per-request header the same way", async () => {
			const { request } = await wire(anthropicModel("claude-haiku-5-5"), {
				headers: { "anthropic-beta": "custom-proxy-beta" },
			});
			expect(request?.betas).toEqual(["custom-proxy-beta", EFFORT, BINDING]);
		});

		it("does not repeat a needed beta the header already lists", async () => {
			const { request } = await wire(
				anthropicModel("claude-haiku-5-5", { "anthropic-beta": `${EFFORT}, custom-proxy-beta` }),
			);
			expect(request?.betas).toEqual([EFFORT, "custom-proxy-beta", BINDING]);
		});

		it("keeps the OAuth identity betas when a header is configured", async () => {
			const { request } = await wire(anthropicModel("claude-haiku-5-5", { "anthropic-beta": "custom-proxy-beta" }), {
				apiKey: "sk-ant-oat01-test",
			});
			expect(request?.betas).toEqual(
				expect.arrayContaining(["custom-proxy-beta", "claude-code-20250219", "oauth-2025-04-20"]),
			);
		});

		it("adds the server-side fallback beta whenever the body carries fallbacks", async () => {
			const { request } = await wire(anthropicModel("claude-opus-5-5", { "anthropic-beta": "custom-proxy-beta" }), {
				refusalFallbacks: "default",
			});
			expect(request?.body.fallbacks).toBe("default");
			expect(request?.betas).toContain(FALLBACK);
		});

		it("adds the tool-changes beta when native tool changes are sent", async () => {
			const { request } = await wire(anthropicModel("claude-opus-4-8", { "anthropic-beta": "custom-proxy-beta" }), {
				context: toolContext,
			});
			expect(request?.betas).toEqual(["custom-proxy-beta", TOOL_CHANGES]);
		});

		describe("a null header sends a request that needs no beta", () => {
			it("uses top-level effort instead of per-message markers on a mid-conversation-effort model", async () => {
				const { result, request } = await wire(anthropicModel("claude-haiku-5-5"), {
					headers: { "anthropic-beta": null },
				});
				expect(result.stopReason).toBe("stop");
				expect(request?.betas).toEqual([]);
				expect(effortMessages(request?.body as CapturedPayload)).toEqual([]);
				expect(JSON.stringify(request?.body.thinking ?? {})).not.toContain("block_binding");
			});

			it("sends the current tool list instead of native tool changes", async () => {
				const { result, request } = await wire(anthropicModel("claude-opus-4-8"), {
					headers: { "anthropic-beta": null },
					context: toolContext,
				});
				expect(result.stopReason).toBe("stop");
				expect(request?.betas).toEqual([]);
				expect(request?.body.tools).toHaveLength(1);
			});

			it("drops server-side fallbacks", async () => {
				const { request } = await wire(anthropicModel("claude-opus-5-5"), {
					headers: { "anthropic-beta": null },
					refusalFallbacks: "default",
				});
				expect(request?.betas).toEqual([]);
				expect(request?.body.fallbacks).toBeUndefined();
			});

			it("fails before sending when an OAuth token needs its identity betas", async () => {
				const { result, requests } = await wire(anthropicModel("claude-haiku-5-5"), {
					headers: { "anthropic-beta": null },
					apiKey: "sk-ant-oat01-test",
				});
				expect(requests).toBe(0);
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toContain("claude-code-20250219");
				expect(result.errorMessage).toContain("anthropic-beta");
			});
		});
	});

	// senpi#2912: the content-less effort markers must survive every pre-send pass and reach the HTTP body.
	it.each(["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"] as const)(
		"puts the chosen effort marker on the wire for %s",
		async (id) => {
			const model = getModel("anthropic", id) as Model<"anthropic-messages">;
			expect(model.compat?.supportsMidConvoEffort).toBe(true);
			const { wire } = await captureWire(
				model,
				{ messages: [user("one", 1), assistant(model, "low"), user("two", 2)] },
				"medium",
			);
			expect(effortMessages(wire)).toEqual([
				{ role: "system", content: [], output_config: { effort: "low" } },
				{ role: "system", content: [], output_config: { effort: "medium" } },
			]);
			expect(wire.messages.at(-1)).toEqual({ role: "system", content: [], output_config: { effort: "medium" } });
		},
	);

	it.each(["claude-sonnet-5-5", "claude-opus-5-5"] as const)(
		"runs a thinking-off turn on %s at low effort on the wire and records low",
		async (id) => {
			const model = getModel("anthropic", id) as Model<"anthropic-messages">;
			const { wire, message } = await captureWire(
				model,
				{ messages: [user("one", 1), assistant(model, "xhigh"), user("two", 2)] },
				undefined,
				false,
			);
			expect(wire.thinking).toBeUndefined();
			expect(wire.output_config).toEqual({ effort: "low" });
			expect(wire.messages.at(-1)).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
			expect(message.providerThinkingLevel).toBe("low");
		},
	);

	it("sends no effort marker beside disabled thinking on a family that can disable it", async () => {
		const model = getModel("anthropic", "claude-opus-5") as Model<"anthropic-messages">;
		const { wire, message } = await captureWire(
			model,
			{ messages: [user("one", 1), assistant(model, "xhigh"), user("two", 2)] },
			undefined,
			false,
		);
		expect(wire.thinking).toEqual({ type: "disabled" });
		expect(effortMessages(wire)).toEqual([]);
		expect(wire.output_config).toBeUndefined();
		expect(message.providerThinkingLevel).toBeUndefined();
	});

	it("generates exact model and transport gates", () => {
		const direct = getModel("anthropic", "claude-fable-5-1");
		const openRouter = getModel("openrouter", "anthropic/claude-fable-5.1");
		const unsupported = getModel("anthropic", "claude-opus-4-8");
		expect(direct.compat?.supportsMidConvoEffort).toBe(true);
		expect(direct.thinkingLevelMap?.off).toBeNull();
		expect(openRouter.api).toBe("anthropic-messages");
		expect(openRouter.baseUrl).toBe("https://openrouter.ai/api");
		expect(openRouter.compat?.supportsMidConvoEffort).toBe(true);
		expect(unsupported.compat?.supportsMidConvoEffort).toBeUndefined();
		// OpenRouter rejects configuration_update on Opus 5 but accepts it on Fable 5.1.
		expect(getModel("openrouter", "anthropic/claude-opus-5").compat?.supportsMidConvoEffort).toBeUndefined();
		expect(getModel("anthropic", "claude-opus-5").compat?.allowedFallbackModels).toBeUndefined();
	});
});
