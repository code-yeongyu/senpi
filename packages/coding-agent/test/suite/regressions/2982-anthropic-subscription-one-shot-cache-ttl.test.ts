import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildDeferredPromptStream,
	buildPromptBlocks,
} from "../../../src/core/extensions/builtin/anthropic-subscription/prompt-bridge.ts";
import { pinOneShotPromptCacheTtl } from "../../../src/core/extensions/builtin/anthropic-subscription/prompt-cache-ttl.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function screenshotLoop(): Message[] {
	return [
		{ role: "user", content: "check the page", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "shot", name: "screenshot", arguments: {} }],
			api: "claude-sdk-oauth",
			provider: "anthropic-subscription",
			model: "claude-test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "shot",
			toolName: "screenshot",
			content: [{ type: "image", data: PNG, mimeType: "image/png" }],
			isError: false,
			timestamp: 3,
		},
	];
}

describe("senpi#2982 the one-shot cache breakpoint matches Claude Code's pinned cache lifetime", () => {
	it.each([
		["oauth-slots", {}, "1h"],
		["config-dir", {}, "1h"],
		["oauth-slots", { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" }, "5m"],
		["ambient", { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }, "1h"],
		["oauth-slots", { FORCE_PROMPT_CACHING_5M: "1" }, "5m"],
		["config-dir", { FORCE_PROMPT_CACHING_5M: "true", CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }, "5m"],
		["ambient", { FORCE_PROMPT_CACHING_5M: "1" }, "5m"],
	] as const)("pins %s with %j to %s for both Claude Code and the breakpoint", (lane, environment, expected) => {
		// given the query options of a one-shot attempt on that lane
		const options: { env?: Record<string, string | undefined> } = {
			env: { CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off" },
		};

		// when its cache lifetime is pinned
		const ttl = pinOneShotPromptCacheTtl(options, lane, environment);

		// then Claude Code receives the same lifetime the breakpoint uses, and other env survives
		expect(ttl).toBe(expected);
		expect(options.env).toEqual({ CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off", CLAUDE_CODE_PROMPT_CACHE_TTL: expected });
	});

	it("pins nothing on the ambient lane, which may be an API key or a subscription login", () => {
		// given an ambient attempt with no explicit lifetime
		const options: { env?: Record<string, string | undefined> } = {};

		// when its cache lifetime is pinned
		const ttl = pinOneShotPromptCacheTtl(options, "ambient", { CLAUDE_CODE_PROMPT_CACHE_TTL: "10m" });

		// then no lifetime is chosen, so the caller adds no breakpoint and Claude Code keeps its own choice
		expect(ttl).toBeUndefined();
		expect(options.env).toBeUndefined();
	});

	it("puts the breakpoint on a text block when the history ends with an image", () => {
		// given a history whose last entry is a screenshot tool result
		// when the turn is rebuilt with a breakpoint
		const blocks = buildPromptBlocks({ messages: screenshotLoop() }, undefined, undefined, { cacheBreakpoint: "1h" });
		const marked = blocks.filter((block) => "cache_control" in block && block.cache_control);

		// then exactly one text block carries it, with the pinned lifetime
		expect(marked).toHaveLength(1);
		expect(marked[0]).toMatchObject({ type: "text", cache_control: { type: "ephemeral", ttl: "1h" } });
	});

	it("builds a fresh prompt each time it is iterated, as a failover retry needs", async () => {
		// given a deferred prompt whose inputs change between attempts
		let attempt = 0;
		const prompt = buildDeferredPromptStream(() => [{ type: "text", text: `attempt ${++attempt}` }]);

		// when two attempts each iterate it
		const read = async () => {
			const texts: string[] = [];
			for await (const message of prompt) {
				const content = message.message.content;
				if (Array.isArray(content)) for (const block of content) if (block.type === "text") texts.push(block.text);
			}
			return texts;
		};

		// then both receive a full prompt, built for their own attempt
		expect(await read()).toEqual(["attempt 1"]);
		expect(await read()).toEqual(["attempt 2"]);
	});
});
