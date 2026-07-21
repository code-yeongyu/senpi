import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { EventProjector } from "../../src/modes/app-server/threads/projection.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		responseId: "response-review",
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

function fileChangeStart(id: string, path: string): AgentSessionEvent {
	const toolCall: ToolCall = {
		type: "toolCall",
		id,
		name: "edit",
		arguments: { path, edits: [{ oldText: "old", newText: "new" }] },
	};
	const message = assistant([toolCall]);
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall, partial: message },
	};
}

function fileChangeEnd(id: string, patch: string): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId: id,
		toolName: "edit",
		result: { content: [{ type: "text", text: "edited" }], details: { patch } },
		isError: false,
	};
}

function valueAt(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`expected object containing ${key}`);
	}
	return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

describe("app-server task 24 review regressions", () => {
	it("preserves meaningful generic items for non-web provider-native content", () => {
		// Given: provider-native blocks that are not OpenAI web_search_call items.
		const message = assistant([
			{
				type: "providerNative",
				subtype: "file_search_call",
				raw: { type: "file_search_call", id: "fs-1", query: "file needle" },
			},
			{
				type: "providerNative",
				subtype: "server_tool_use",
				raw: { type: "server_tool_use", name: "web_search", input: { query: "server needle" } },
			},
			{
				type: "providerNative",
				subtype: "groundingMetadata",
				raw: { webSearchQueries: ["grounded needle"] },
			},
		]);
		const projector = new EventProjector({ threadId: "thread", turnId: "turn" });

		// When: the completed assistant message is projected.
		const items = projector
			.project({ type: "message_end", message })
			.notifications.filter((notification) => notification.method === "item/completed")
			.map((notification) => valueAt(notification.params, "item"));

		// Then: every generic fallback remains readable instead of becoming a blank fabricated search.
		expect(items).toHaveLength(3);
		expect(items[0]).toMatchObject({
			type: "webSearch",
			query: expect.stringContaining("file_search_call"),
			action: null,
			results: null,
		});
		expect(items[1]).toMatchObject({
			type: "webSearch",
			query: expect.stringContaining('query: "server needle"'),
			action: null,
			results: null,
		});
		expect(items[2]).toMatchObject({
			type: "webSearch",
			query: expect.stringContaining('query: "grounded needle"'),
			action: null,
			results: null,
		});
	});

	it("maps incomplete or unknown web-search actions to other", () => {
		// Given: recognized web-search calls with no action and a future action variant.
		const message = assistant([
			{
				type: "providerNative",
				subtype: "web_search_call",
				raw: { type: "web_search_call", id: "ws-missing", status: "in_progress" },
			},
			{
				type: "providerNative",
				subtype: "web_search_call",
				raw: { type: "web_search_call", id: "ws-future", action: { type: "future_action" } },
			},
		]);
		const projector = new EventProjector({ threadId: "thread", turnId: "turn" });

		// When: the provider-native items are projected.
		const items = projector
			.project({ type: "message_end", message })
			.notifications.filter((notification) => notification.method === "item/completed")
			.map((notification) => valueAt(notification.params, "item"));

		// Then: Codex-compatible other actions preserve honest unknown state.
		for (const item of items) {
			expect(item).toMatchObject({ type: "webSearch", query: "", action: { type: "other" }, results: null });
		}
	});

	it("rebuilds cumulative diffs in file-change source order after out-of-order completion", () => {
		// Given: two file-change items that start in source order one, two.
		const projector = new EventProjector({ threadId: "thread", turnId: "turn" });
		const patchOne = "--- one.ts\n+++ one.ts\n@@ -1 +1 @@\n-old\n+one\n";
		const patchTwo = "--- two.ts\n+++ two.ts\n@@ -1 +1 @@\n-old\n+two\n";

		// When: item two completes first, item one completes second, and item one repeats.
		const diffs: unknown[] = [];
		for (const event of [
			fileChangeStart("edit-1", "one.ts"),
			fileChangeStart("edit-2", "two.ts"),
			fileChangeEnd("edit-2", patchTwo),
			fileChangeEnd("edit-1", patchOne),
			fileChangeEnd("edit-1", patchOne),
		]) {
			for (const notification of projector.project(event).notifications) {
				if (notification.method === "turn/diff/updated") diffs.push(valueAt(notification.params, "diff"));
			}
		}

		// Then: only changed values emit, and the final cumulative value follows source order.
		expect(diffs).toEqual([patchTwo, `${patchOne}${patchTwo}`]);
	});
});
