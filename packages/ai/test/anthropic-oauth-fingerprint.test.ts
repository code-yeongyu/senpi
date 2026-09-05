import type {
	BetaTextBlockParam,
	MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { describe, expect, it } from "vitest";
import type { AnthropicOptions } from "../src/api/anthropic-messages.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, Model, UserMessage } from "../src/types.ts";
import { getPiUserAgent } from "../src/utils/pi-user-agent.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 4096,
};

function user(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 0 };
}

function sseResponse(): Response {
	const events = [
		{
			type: "message_start",
			message: { id: "msg_test", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } },
		},
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

interface CapturedRequest {
	body: MessageCreateParamsStreaming;
	headers: Headers;
}

async function capture(
	context: Context,
	options: AnthropicOptions = {},
	requestModel = model,
	rejectForcedToolChoice = false,
): Promise<CapturedRequest[]> {
	const requests: CapturedRequest[] = [];
	// Keep the real SDK and provider path; only the final HTTP transport is replaced.
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		expect(request.method).toBe("POST");
		expect(new URL(request.url).pathname).toBe("/v1/messages");
		requests.push({ body: (await request.json()) as MessageCreateParamsStreaming, headers: request.headers });
		if (rejectForcedToolChoice && requests.length === 1) {
			return Response.json(
				{ type: "error", error: { type: "invalid_request_error", message: "tool_choice is not supported" } },
				{ status: 400 },
			);
		}
		return sseResponse();
	};
	const result = await streamAnthropic(requestModel, context, {
		apiKey: "sk-ant-oat01-offline-fixture",
		cacheRetention: "none",
		maxRetries: 0,
		...options,
		fetch,
	}).result();
	expect(result.errorMessage).toBeUndefined();
	expect(result.stopReason).toBe("stop");
	expect(requests).toHaveLength(rejectForcedToolChoice ? 2 : 1);
	return requests;
}

function systemBlocks(body: MessageCreateParamsStreaming): BetaTextBlockParam[] {
	if (!Array.isArray(body.system)) throw new Error("Expected system blocks");
	return body.system;
}

function billingFields(body: MessageCreateParamsStreaming): Record<string, string> {
	const block = systemBlocks(body)[0];
	expect(block.type).toBe("text");
	expect(block.cache_control).toBeUndefined();
	const match =
		/^x-anthropic-billing-header: cc_version=(\d+\.\d+\.\d+\.[a-f0-9]{3}); cc_entrypoint=([^;]+); cch=([a-f0-9]{5});$/.exec(
			block.text,
		);
	expect(match).not.toBeNull();
	return { cc_version: match![1], cc_entrypoint: match![2], cch: match![3] };
}

describe("Anthropic native OAuth request fingerprint", () => {
	// Golden SHA-256 prefixes from the local patch's salt, UTF-8 input and 2.1.251 version.
	const cases: { name: string; content: UserMessage["content"]; suffix: string; cch: string }[] = [
		{ name: "string", content: "First user fingerprint input.", suffix: "050", cch: "e1cb1" },
		{
			name: "text blocks (first block only)",
			content: [
				{ type: "text", text: "First text block fingerprint." },
				{ type: "text", text: "Ignored second block" },
			],
			suffix: "02e",
			cch: "7fd95",
		},
		{
			name: "image before text",
			content: [
				{ type: "image", data: "AA==", mimeType: "image/png" },
				{ type: "text", text: "First text block fingerprint." },
			],
			suffix: "02e",
			cch: "7fd95",
		},
		{ name: "short text", content: "Hi", suffix: "76b", cch: "3639e" },
		{ name: "empty string", content: "", suffix: "76b", cch: "e3b0c" },
		{ name: "empty text blocks", content: [{ type: "text", text: "" }], suffix: "76b", cch: "e3b0c" },
		{
			name: "image only",
			content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
			suffix: "76b",
			cch: "e3b0c",
		},
	];
	it.each(cases)("fingerprints $name at the final fetch", async ({ content, suffix, cch }) => {
		const [request] = await capture({ messages: [user(content)] });
		expect(billingFields(request.body)).toEqual({ cc_version: `2.1.251.${suffix}`, cc_entrypoint: "sdk-cli", cch });
		expect(request.headers.get("user-agent")).toBe("claude-cli/2.1.251 (external, cli)");
		expect(request.headers.get("x-app")).toBe("cli");
		expect(
			request.headers
				.get("anthropic-beta")
				?.split(",")
				.map((value) => value.trim()),
		).toContain("oauth-2025-04-20");
		expect(request.headers.has("authorization")).toBe(true);
		expect(request.headers.has("x-api-key")).toBe(false);
		expect(systemBlocks(request.body)).toHaveLength(2);
	});

	it("is deterministic across later input and uses the first serialized user message", async () => {
		const [first] = await capture({ messages: [user("First user fingerprint input.")] });
		const [later] = await capture({
			messages: [user("First user fingerprint input."), user("Later visible user input.")],
		});
		const [changed] = await capture({ messages: [user(""), user("Changed first user input.")] });
		expect(billingFields(later.body)).toEqual(billingFields(first.body));
		expect(billingFields(changed.body)).toEqual({
			cc_version: "2.1.251.ee3",
			cc_entrypoint: "sdk-cli",
			cch: "2ed02",
		});
	});

	it.each(["none", "short", "long"] as const)(
		"preserves caller system and cache metadata with %s retention",
		async (cacheRetention) => {
			const context: Context = {
				systemPrompt: "Caller-owned system",
				messages: [user("First user fingerprint input.")],
			};
			const original = structuredClone(context);
			const [request] = await capture(context, { cacheRetention, metadata: { user_id: "offline-user" } });
			const cacheControl =
				cacheRetention === "none"
					? undefined
					: { type: "ephemeral", ...(cacheRetention === "long" ? { ttl: "1h" } : {}) };
			const blocks = systemBlocks(request.body);
			expect(billingFields(request.body).cch).toBe("e1cb1");
			expect(blocks).toHaveLength(3);
			expect(blocks[1].cache_control).toBeUndefined();
			expect(blocks[2]).toEqual({
				type: "text",
				text: context.systemPrompt,
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
			expect(request.body.metadata).toEqual({ user_id: "offline-user" });
			if (cacheControl)
				expect(request.body.messages[0].content).toEqual([
					{ type: "text", text: "First user fingerprint input.", cache_control: cacheControl },
				]);
			expect(context).toEqual(original);
		},
	);

	it("retains the identity cache checkpoint when no caller system prompt exists", async () => {
		const [request] = await capture({ messages: [user("Hi")] }, { cacheRetention: "short" });
		const blocks = systemBlocks(request.body);
		expect(billingFields(request.body).cch).toBe("3639e");
		expect(blocks).toHaveLength(2);
		expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
	});

	it("leaves payload-hook system blocks and their metadata intact", async () => {
		const callerBlock: BetaTextBlockParam = {
			type: "text",
			text: "Hook-owned system",
			cache_control: { type: "ephemeral", ttl: "1h" },
			citations: [],
		};
		const original = structuredClone(callerBlock);
		const [request] = await capture(
			{ messages: [user("Hi")] },
			{
				onPayload: (payload) => {
					const params = payload as MessageCreateParamsStreaming;
					expect(billingFields(params).cc_entrypoint).toBe("sdk-cli");
					return { ...params, system: [...systemBlocks(params), callerBlock] };
				},
			},
		);
		expect(systemBlocks(request.body)[2]).toEqual(original);
		expect(callerBlock).toEqual(original);
	});

	it("preserves the fingerprint through forced-tool-choice fallback without rerunning the hook", async () => {
		let hookCalls = 0;
		const requests = await capture(
			{ messages: [user("Hi")] },
			{
				toolChoice: "any",
				onPayload: () => {
					hookCalls++;
				},
			},
			model,
			true,
		);
		expect(requests[0].body.tool_choice).toEqual({ type: "any" });
		expect(requests[1].body.tool_choice).toBeUndefined();
		expect(billingFields(requests[1].body)).toEqual(billingFields(requests[0].body));
		expect(requests[1].body.system).toEqual(requests[0].body.system);
		expect(hookCalls).toBe(1);
	});

	it.each(["anthropic", "cloudflare-ai-gateway", "github-copilot"])(
		"does not add OAuth fingerprint fields to the %s non-native path",
		async (provider) => {
			const [request] = await capture(
				{ systemPrompt: "Caller-owned system", messages: [user("Hi")] },
				{
					apiKey: provider === "anthropic" ? "sk-ant-api03-offline-fixture" : "sk-ant-oat01-offline-fixture",
				},
				{ ...model, provider },
			);
			expect(request.body.system).toEqual([{ type: "text", text: "Caller-owned system" }]);
			expect(request.headers.get("user-agent")).not.toContain("claude-cli/");
			expect(request.headers.has("x-app")).toBe(false);
			expect(request.headers.get("anthropic-beta")).not.toContain("oauth-2025-04-20");
			if (provider === "anthropic") {
				expect(request.headers.get("user-agent")).toBe(getPiUserAgent());
				expect(request.headers.has("x-api-key")).toBe(true);
				expect(request.headers.has("authorization")).toBe(false);
			}
		},
	);
});
