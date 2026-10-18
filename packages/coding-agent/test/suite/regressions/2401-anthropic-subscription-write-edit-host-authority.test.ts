import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQueryInput,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import {
	BUILTIN_SDK_TOOLS,
	HOST_TOOL_DENIAL_HOOKS,
	TOOL_EXECUTION_DENIED_MESSAGE,
} from "../../../src/core/extensions/builtin/anthropic-subscription/tools.ts";
import { createEditToolDefinition } from "../../../src/core/tools/edit.ts";
import { createReadToolDefinition } from "../../../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../../../src/core/tools/write.ts";

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

// Claude Code runs its own read-before-write validator on these built-ins before any PreToolUse hook,
// so exposing them lets the SDK answer a call that senpi also executes (issue #2401).
const PRE_HOOK_VALIDATED_BUILTINS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

function hostFileTools(): Context["tools"] {
	return [
		createReadToolDefinition("/workspace"),
		createWriteToolDefinition("/workspace"),
		createEditToolDefinition("/workspace"),
	].map((definition) => ({
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
	}));
}

function sdk(value: unknown): SDKMessage {
	return value as SDKMessage;
}

const editInput = { path: "/outside/notes.md", edits: [{ oldText: "beta", newText: "beta-edited" }] };

function editTurn(): SDKMessage[] {
	return [
		sdk({
			type: "stream_event",
			event: { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } },
		}),
		sdk({
			type: "stream_event",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_edit", name: "mcp__custom-tools__edit", input: {} },
			},
		}),
		sdk({
			type: "stream_event",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: JSON.stringify(editInput) },
			},
		}),
		sdk({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
		sdk({
			type: "stream_event",
			event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
		}),
		sdk({
			type: "user",
			parent_tool_use_id: null,
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_edit",
						is_error: true,
						content: TOOL_EXECUTION_DENIED_MESSAGE,
					},
				],
			},
		}),
		sdk({ type: "result", subtype: "success", is_error: false, stop_reason: "tool_use", result: "" }),
	];
}

function captureQuery(messages: SDKMessage[]): { options: () => Options } {
	let captured: Options | undefined;
	overrideSdkBoundary({
		query: (input: SdkQueryInput) => {
			captured = input.options;
			return {
				async *[Symbol.asyncIterator]() {
					yield* messages;
				},
				async interrupt() {},
				close() {},
			};
		},
	});
	return {
		options: () => {
			if (!captured) throw new Error("query was never called");
			return captured;
		},
	};
}

afterEach(() => resetSdkBoundary());

describe("regression #2401: senpi is the single authority for subscription-lane write/edit", () => {
	it("never offers Claude Code's pre-hook-validated file built-ins to the SDK", async () => {
		const query = captureQuery(editTurn());
		await streamAnthropicSubscription(model, { messages: [], tools: hostFileTools() }).result();

		const offered = query.options().tools;
		expect(Array.isArray(offered)).toBe(true);
		for (const builtin of PRE_HOOK_VALIDATED_BUILTINS) {
			expect(offered).not.toContain(builtin);
			expect(BUILTIN_SDK_TOOLS).not.toContain(builtin);
		}
		expect(offered).toContain("Read");
	});

	it("serves senpi write and edit through the custom-tools MCP server that the host deny hook answers", async () => {
		const query = captureQuery(editTurn());
		await streamAnthropicSubscription(model, { messages: [], tools: hostFileTools() }).result();

		expect(Object.keys(query.options().mcpServers ?? {})).toEqual(["custom-tools"]);
		const matcher = new RegExp(`^(?:${HOST_TOOL_DENIAL_HOOKS.PreToolUse?.[0]?.matcher ?? "(?!)"})$`);
		expect(matcher.test("mcp__custom-tools__write")).toBe(true);
		expect(matcher.test("mcp__custom-tools__edit")).toBe(true);
	});

	it("turns one SDK edit tool_use into exactly one host edit call with senpi's arguments intact", async () => {
		captureQuery(editTurn());
		const message = await streamAnthropicSubscription(model, { messages: [], tools: hostFileTools() }).result();

		const calls = message.content.filter((block) => block.type === "toolCall");
		expect(calls).toEqual([{ type: "toolCall", id: "toolu_edit", name: "edit", arguments: editInput }]);
		expect(message.stopReason).toBe("toolUse");
	});
});
