import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { type BedrockOptions, stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel, getModels, normalizeContext, streamSimple } from "../src/compat.ts";
import { modelSupportsAssistantPrefill } from "../src/model.ts";
import { calculateCost, getSupportedThinkingLevels } from "../src/models.ts";
import type { Context, Model, SimpleStreamOptions, Usage } from "../src/types.ts";
import { getAnthropicCompat } from "../src/utils/prompt-cache-ttl.ts";

// Claude Haiku 5.5 (2026-10-07), senpi#2892. Generated-catalog and request-shape contract.
// https://platform.claude.com/docs/en/models/haiku-5-5/overview and .../haiku-5-5/migration-guide:
// 1M in / 128k out (senpi defaults to the 100K price band with 32K out; 1M / 128K is a models.json opt-in), text + image input, adaptive thinking with effort low..max (`budget_tokens` is a
// 400, so `thinking` stays unset or adaptive), no `temperature` / `top_p` / `top_k`, forced
// `tool_choice` accepted (unlike Opus/Sonnet 5.5), no server-side refusal fallback, and $0.1 / $0.5
// per MTok with 0.01 cache reads and 0.125 cache writes; a prompt over 100,000 input tokens bills
// the whole request at 0.5 / 2.5 / 0.05 / 0.625.

const HAIKU_55_COST = {
	input: 0.1,
	output: 0.5,
	cacheRead: 0.01,
	cacheWrite: 0.125,
	tiers: [{ inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
};

interface AnthropicPayload {
	messages: Array<{ role: string; output_config?: { effort?: string } }>;
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
	tool_choice?: { type: string; name?: string };
	temperature?: number;
	top_p?: number;
	top_k?: number;
}

const SSE_OK = [
	{ type: "message_start", message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } } },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 1 } },
	{ type: "message_stop" },
]
	.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("");

/** Records the JSON body that actually reaches `fetch`, i.e. what Anthropic receives. */
function wireRecorder(): { fetch: typeof fetch; body: () => AnthropicPayload } {
	let captured: AnthropicPayload | undefined;
	return {
		fetch: async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			captured = (await request.json()) as AnthropicPayload;
			return new Response(SSE_OK, { status: 200, headers: { "content-type": "text/event-stream" } });
		},
		body: () => {
			if (!captured) throw new Error("Expected the request body to reach fetch");
			return captured;
		},
	};
}

function makeContext(withTool = false): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		...(withTool
			? {
					tools: [
						{
							name: "lookup",
							description: "Look up a value",
							parameters: Type.Object({ key: Type.String() }),
						},
					],
				}
			: {}),
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicPayload> {
	const wire = wireRecorder();
	await streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		...options,
		apiKey: "fake-key",
		cacheRetention: "none",
		fetch: wire.fetch,
	}).result();
	return wire.body();
}

function haiku55(): Model<"anthropic-messages"> {
	const model = getModel("anthropic", "claude-haiku-5-5");
	expect(model, "anthropic/claude-haiku-5-5 must exist in the generated catalog").toBeDefined();
	return model as Model<"anthropic-messages">;
}

function mapLessHaiku55(): Model<"anthropic-messages"> {
	return {
		id: "claude-haiku-5-5",
		name: "Claude Haiku 5.5",
		api: "anthropic-messages",
		provider: "custom-gateway",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	};
}

function usage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("Claude Haiku 5.5 catalog row (anthropic)", () => {
	it("carries the documented limits, input, prices and effort ladder", () => {
		const model = haiku55();
		expect(model.contextWindow).toBe(100_000);
		expect(model.maxTokens).toBe(32_000);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.cost).toEqual(HAIKU_55_COST);
		expect(model.reasoning).toBe(true);
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it("is adaptive-only with per-message effort, keeps forced tool choice and has no refusal fallback", () => {
		const model = haiku55();
		expect(model.thinkingLevelMap?.off).toBeNull();
		expect(model.compat?.supportsDisabledThinking).toBe(false);
		expect(model.compat?.forceAdaptiveThinking).toBe(true);
		expect(model.compat?.supportsTemperature).toBe(false);
		expect(model.compat?.supportsMidConvoEffort).toBe(true);
		expect(model.compat?.supportsMidConvoSystemMessages).toBe(true);
		expect(model.compat?.allowedFallbackModels).toBeUndefined();
		expect(getAnthropicCompat(model).supportsForcedToolChoice).toBe(true);
		// Listed in Anthropic's tool-search table, but Haiku 4.5 was listed too and rejects tool_reference;
		// off until a live probe (senpi#2914).
		expect(getAnthropicCompat(model).supportsToolReferences).toBe(false);
	});

	it("bills a prompt over 100,000 input tokens entirely at the long-context rate", () => {
		const model = haiku55();
		const long = calculateCost(model, usage(150_000, 2_000));
		expect(long.input).toBeCloseTo(0.075, 10);
		expect(long.output).toBeCloseTo(0.005, 10);
		// Exactly 100,000 is not "over 100K": the base rate still applies.
		const atThreshold = calculateCost(model, usage(100_000, 2_000));
		expect(atThreshold.input).toBeCloseTo(0.01, 10);
		expect(atThreshold.output).toBeCloseTo(0.001, 10);
	});
});

describe("Claude Haiku 5.5 catalog rows (every route)", () => {
	it("bills every Haiku 5.5 row at five times its base rates above 100,000 input tokens", () => {
		const rows = [
			"anthropic",
			"amazon-bedrock",
			"opencode",
			"opencode-go",
			"openrouter",
			"vercel-ai-gateway",
			"venice",
		] as const;
		const found = rows.flatMap((provider) => getModels(provider).filter((model) => /haiku-5[.-]5/.test(model.id)));
		expect(new Set(found.map((model) => model.provider))).toEqual(new Set(rows));
		for (const model of found) {
			// The window stops where the 5x band starts, so compaction runs before a prompt crosses it.
			expect(model.contextWindow, `${model.provider}/${model.id} window`).toBe(100_000);
			// Below half the window, so the output reserve leaves emergency pruning at about 65% of it.
			expect(model.maxTokens, `${model.provider}/${model.id} maxTokens`).toBe(32_000);
			const { tiers, ...base } = model.cost;
			expect(tiers, `${model.provider}/${model.id}`).toHaveLength(1);
			const tier = tiers?.[0];
			expect(tier?.inputTokensAbove).toBe(100_000);
			for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
				expect(tier?.[key], `${model.provider}/${model.id} ${key}`).toBeCloseTo(base[key] * 5, 6);
			}
		}
	});
});

describe("Claude Haiku 5.5 catalog rows (Amazon Bedrock)", () => {
	it("ships the on-demand id and the global inference profile with the same contract", () => {
		const ids = getModels("amazon-bedrock").map((model) => model.id);
		expect(ids).toContain("anthropic.claude-haiku-5-5");
		expect(ids).toContain("global.anthropic.claude-haiku-5-5");
		for (const id of ["anthropic.claude-haiku-5-5", "global.anthropic.claude-haiku-5-5"] as const) {
			const model = getModel("amazon-bedrock", id);
			expect(model.contextWindow).toBe(100_000);
			expect(model.maxTokens).toBe(32_000);
			expect(model.cost).toEqual(HAIKU_55_COST);
			expect(model.thinkingLevelMap?.off).toBeNull();
			expect(getSupportedThinkingLevels(model)).not.toContain("off");
			expect(getSupportedThinkingLevels(model)).toEqual(
				expect.arrayContaining(["low", "medium", "high", "xhigh", "max"]),
			);
		}
	});

	it("sends adaptive thinking with an effort, never budget_tokens", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-haiku-5-5");
		expect(
			model,
			"amazon-bedrock/global.anthropic.claude-haiku-5-5 must exist in the generated catalog",
		).toBeDefined();
		let captured:
			| { additionalModelRequestFields?: { thinking?: { type: string; budget_tokens?: number } } }
			| undefined;
		const options: BedrockOptions = {
			reasoning: "medium",
			signal: AbortSignal.abort(),
			onPayload: (payload) => {
				captured = payload as typeof captured;
				return payload;
			},
		};
		for await (const event of streamBedrock(model, normalizeContext(makeContext()), options)) {
			if (event.type === "error") break;
		}
		expect(captured?.additionalModelRequestFields).toMatchObject({
			thinking: { type: "adaptive" },
			output_config: { effort: "medium" },
		});
		expect(captured?.additionalModelRequestFields?.thinking?.budget_tokens).toBeUndefined();
	});
});

describe("Claude Haiku 5.5 API contract (migration guide)", () => {
	// https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide: temperature/top_p/top_k,
	// `thinking.budget_tokens` and an assistant prefill are 400s; thinking is adaptive with effort.
	it("never sends sampling params, budget_tokens or a prefill, and sends adaptive thinking with effort", async () => {
		const model = haiku55();
		const wire = wireRecorder();
		await streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
			apiKey: "fake-key",
			cacheRetention: "none",
			reasoning: "high",
			temperature: 0.2,
			samplingParams: { top_p: 0.5, top_k: 10 },
			fetch: wire.fetch,
		}).result();
		const body = wire.body();

		for (const key of ["temperature", "top_p", "top_k"]) expect(body).not.toHaveProperty(key);
		expect(body.thinking?.type).toBe("adaptive");
		expect(body.thinking?.budget_tokens).toBeUndefined();
		expect(body.messages.at(-1)).toMatchObject({ role: "system", output_config: { effort: "high" } });
		// The request ends on the user turn plus its effort marker, never on an assistant turn.
		expect(body.messages.filter((message) => message.role !== "system").at(-1)?.role).toBe("user");
		// No prefill is ever offered: the catalog row does not claim support (the agent loop also refuses
		// to continue from an assistant message, packages/agent/test/e2e.test.ts).
		expect(model.supportsAssistantPrefill).toBeUndefined();
		expect(modelSupportsAssistantPrefill(model, { thinkingEnabled: false })).toBe(false);
	});

	// https://platform.claude.com/docs/en/build-with-claude/prompt-caching: changing the top-level
	// `output_config.effort` invalidates cached message blocks; a per-message effort change keeps the cache
	// (https://platform.claude.com/docs/en/build-with-claude/effort#change-effort-mid-conversation-beta).
	it("keeps the top-level effort fixed and moves only the trailing marker when effort changes", async () => {
		const bodies: AnthropicPayload[] = [];
		for (const reasoning of ["low", "max"] as const) {
			const wire = wireRecorder();
			await streamSimple({ ...haiku55(), baseUrl: "http://127.0.0.1:9" }, makeContext(), {
				apiKey: "fake-key",
				cacheRetention: "none",
				reasoning,
				fetch: wire.fetch,
			}).result();
			bodies.push(wire.body());
		}
		const [low, max] = bodies;
		expect(low?.output_config).toEqual(max?.output_config);
		expect(low?.thinking).toEqual(max?.thinking);
		expect(low?.messages.slice(0, -1)).toEqual(max?.messages.slice(0, -1));
		expect(low?.messages.at(-1)).toMatchObject({ output_config: { effort: "low" } });
		expect(max?.messages.at(-1)).toMatchObject({ output_config: { effort: "max" } });
	});

	// Thinking is on by default, may arrive as an empty block carrying only a signature, and bills as
	// output: `usage.output_tokens` already includes thinking tokens.
	it("reads a leading signature-only thinking block by type and bills thinking as output", async () => {
		const events = [
			{
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 10, output_tokens: 0 } },
			},
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-haiku" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
			{ type: "content_block_stop", index: 1 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 10, output_tokens: 1000, output_tokens_details: { thinking_tokens: 800 } },
			},
			{ type: "message_stop" },
		];
		const sse = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
		const message = await streamSimple({ ...haiku55(), baseUrl: "http://127.0.0.1:9" }, makeContext(), {
			apiKey: "fake-key",
			cacheRetention: "none",
			reasoning: "medium",
			fetch: async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(message.content.map((block) => block.type)).toEqual(["thinking", "text"]);
		expect(message.content.find((block) => block.type === "text")).toMatchObject({ text: "answer" });
		expect(message.content[0]).toMatchObject({ thinking: "", thinkingSignature: "sig-haiku" });
		expect(message.usage.output).toBe(1000);
		expect(message.usage.reasoning).toBe(800);
		expect(message.usage.cost.output).toBeCloseTo((1000 * 0.5) / 1_000_000, 12);
	});
});

describe("Claude Haiku 5.5 request shape (anthropic-messages)", () => {
	it("runs adaptive thinking with per-message effort and sends no sampling params", async () => {
		const payload = await capturePayload(haiku55(), { reasoning: "medium", temperature: 0.2 });
		expect(payload.thinking).toEqual({
			type: "adaptive",
			display: "summarized",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		});
		expect(payload.messages.at(-1)).toMatchObject({ output_config: { effort: "medium" } });
		expect(payload).not.toHaveProperty("temperature");
		expect(payload).not.toHaveProperty("top_p");
		expect(payload).not.toHaveProperty("top_k");
	});

	it("never sends thinking.type=disabled or a temperature on a thinking-off turn", async () => {
		const payload = await capturePayload(haiku55(), { temperature: 0.2 });
		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toEqual({ effort: "low" });
		expect(payload.messages.at(-1)).toMatchObject({ role: "system", output_config: { effort: "low" } });
		expect(payload).not.toHaveProperty("temperature");
	});

	it("keeps a forced tool_choice, which Haiku 5.5 accepts", async () => {
		const wire = wireRecorder();
		await streamAnthropic({ ...haiku55(), baseUrl: "http://127.0.0.1:9" }, normalizeContext(makeContext(true)), {
			apiKey: "fake-key",
			cacheRetention: "none",
			thinkingEnabled: true,
			effort: "medium",
			toolChoice: { type: "tool", name: "lookup" },
			fetch: wire.fetch,
		}).result();
		expect(wire.body().tool_choice).toEqual({ type: "tool", name: "lookup" });
	});

	it("pins effort low for a thinking-off turn on a map-less gateway row", async () => {
		const payload = await capturePayload(mapLessHaiku55());
		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toEqual({ effort: "low" });
	});

	it.each([
		["medium", "medium"],
		["xhigh", "xhigh"],
		["max", "max"],
	] as const)("maps reasoning %s to adaptive effort %s on a map-less gateway row", async (reasoning, effort) => {
		const payload = await capturePayload(mapLessHaiku55(), { reasoning });
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort });
	});
});
