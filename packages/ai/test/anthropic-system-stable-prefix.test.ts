import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildAnthropicWarmPromptCacheParams, stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getBuiltinModel as getModel } from "../src/providers/all.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/providers/faux.ts";
import type { Context } from "../src/types.ts";
import { getCurrentSystemPrompt, normalizeContext } from "../src/utils/transcript.ts";

const STABLE = "You are concise.\n\n# Project rules\nKeep diffs small.";
const VOLATILE = "\n\n<memory>revision 7</memory>";
const PROMPT = `${STABLE}${VOLATILE}`;

function context(stablePrefix?: string): Context {
	return {
		systemPrompt: PROMPT,
		...(stablePrefix === undefined ? {} : { systemPromptStablePrefix: stablePrefix }),
		messages: [
			{ role: "user", content: "Inspect the repository", timestamp: 1 },
			fauxAssistantMessage(fauxToolCall("read", {}, { id: "toolu_a" }), { stopReason: "toolUse" }),
			{
				role: "toolResult",
				toolCallId: "toolu_a",
				toolName: "read",
				content: [{ type: "text", text: "a" }],
				isError: false,
				timestamp: 2,
			},
		],
		tools: [{ name: "read", description: "Read a file", parameters: Type.Object({}) }],
	};
}

function breakpoints(payload: unknown): number {
	return JSON.stringify(payload).match(/"cache_control"/g)?.length ?? 0;
}

describe("Anthropic system prompt stable prefix (senpi#4447)", () => {
	const model = getModel("anthropic", "claude-sonnet-4-5");

	it("sends the stable prefix as its own block holding the system breakpoint, the rest unmarked", () => {
		const params = buildAnthropicWarmPromptCacheParams(model, context(STABLE));

		expect(params.system).toEqual([
			{ type: "text", text: STABLE, cache_control: { type: "ephemeral" } },
			{ type: "text", text: VOLATILE },
		]);
	});

	it("keeps the breakpoint count of the unsplit request", () => {
		expect(breakpoints(buildAnthropicWarmPromptCacheParams(model, context(STABLE)))).toBe(
			breakpoints(buildAnthropicWarmPromptCacheParams(model, context())),
		);
	});

	it("sends one block when the prompt does not start with the declared prefix", () => {
		const params = buildAnthropicWarmPromptCacheParams(model, context("something else"));

		expect(params.system).toEqual([{ type: "text", text: PROMPT, cache_control: { type: "ephemeral" } }]);
	});

	it("puts the OAuth system breakpoint on the stable block too", async () => {
		let payload: { system?: unknown } | undefined;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			payload = JSON.parse(String(init?.body));
			return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};
		await streamAnthropic(model, normalizeContext(context(STABLE)), { apiKey: "sk-ant-oat-test", fetch }).result();

		expect(payload?.system).toEqual([
			{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
			{ type: "text", text: STABLE, cache_control: { type: "ephemeral" } },
			{ type: "text", text: VOLATILE },
		]);
	});

	it("sends one block when a rewrite left a stable prefix the prompt no longer starts with", async () => {
		let payload: { system?: unknown } | undefined;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			payload = JSON.parse(String(init?.body));
			return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};
		const transcript = normalizeContext(context(STABLE));
		const [leading, ...rest] = transcript.messages;
		if (leading?.role !== "system") throw new Error("expected a leading system message");
		const rewritten = "A context_with_system handler replaced the whole prompt.";
		await streamAnthropic(
			model,
			{ ...transcript, messages: [{ ...leading, content: rewritten }, ...rest] },
			{
				apiKey: "sk-ant-api-test",
				fetch,
			},
		).result();

		expect(payload?.system).toEqual([{ type: "text", text: rewritten, cache_control: { type: "ephemeral" } }]);
	});

	it("leaves the rendered system prompt unchanged for every other provider", () => {
		expect(getCurrentSystemPrompt(normalizeContext(context(STABLE)).messages)).toBe(PROMPT);
	});
});
