import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import {
	NotificationRouter,
	type RoutableConnection,
	type RoutableThread,
	type RouterNotification,
} from "../../src/modes/app-server/server/notifications.ts";
import { EventProjector } from "../../src/modes/app-server/threads/projection.ts";
import type { ProjectedNotification } from "../../src/modes/app-server/threads/projection-types.ts";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

class CapturingConnection implements RoutableConnection {
	readonly id: string;
	readonly initialized = true;
	readonly transport = "ws";
	readonly received: RouterNotification[] = [];

	constructor(id: string) {
		this.id = id;
	}

	send(notification: RouterNotification): void {
		this.received.push(notification);
	}
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		responseId: "response-1",
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

function thread(id: string, subscribers: readonly string[]): RoutableThread {
	return { id, subscribers: new Set(subscribers), queuedTerminalNotifications: [] };
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

function fileChangeEnd(id: string, path: string, patch: string): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId: id,
		toolName: "edit",
		result: {
			content: [{ type: "text", text: `edited ${path}` }],
			details: { diff: patch, patch, firstChangedLine: 1 },
		},
		isError: false,
	};
}

function route(router: NotificationRouter, threadId: string, notifications: readonly ProjectedNotification[]): void {
	for (const notification of notifications) router.toThread(threadId, notification);
}

function diffNotifications(connection: CapturingConnection): readonly RouterNotification[] {
	return connection.received.filter((notification) => notification.method === "turn/diff/updated");
}

describe("app-server task 24 projection and routing", () => {
	it("projects the Codex HEAD webSearch shape from provider metadata", () => {
		// Given: an OpenAI native web search call with an explicit source action.
		const message = assistant([
			{
				type: "providerNative",
				subtype: "web_search_call",
				raw: {
					type: "web_search_call",
					id: "ws-1",
					status: "completed",
					action: { type: "search", query: "senpi parity", queries: null },
				},
			},
		]);
		const projector = new EventProjector({ threadId: "thread-1", turnId: "turn-1", nowMs: () => 1234 });

		// When: the completed assistant message is projected.
		const notifications = projector.project({ type: "message_end", message }).notifications;

		// Then: both lifecycle frames carry the exact HEAD webSearch item shape.
		expect(notifications).toHaveLength(2);
		for (const notification of notifications) {
			expect(notification.params).toMatchObject({
				threadId: "thread-1",
				turnId: "turn-1",
				item: {
					type: "webSearch",
					id: "response-1:providerNative:0",
					query: "senpi parity",
					action: { type: "search", query: "senpi parity", queries: null },
					results: null,
				},
			});
		}
	});

	it("emits two growing turn diffs only to subscribers with populated envelopes", () => {
		// Given: three initialized clients, only two subscribed to the scripted turn.
		const first = new CapturingConnection("first");
		const second = new CapturingConnection("second");
		const outsider = new CapturingConnection("outsider");
		const router = new NotificationRouter({
			connections: [first, second, outsider],
			threads: [thread("thread-1", [first.id, second.id])],
			now: () => 4242,
		});
		const projector = new EventProjector({ threadId: "thread-1", turnId: "turn-1" });
		const firstPatch = "--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-old\n+new\n";
		const secondPatch = "--- a/two.ts\n+++ b/two.ts\n@@ -1 +1 @@\n-old\n+new\n";

		// When: two file changes complete, followed by a duplicate completion.
		for (const event of [
			fileChangeStart("edit-1", "one.ts"),
			fileChangeEnd("edit-1", "one.ts", firstPatch),
			fileChangeStart("edit-2", "two.ts"),
			fileChangeEnd("edit-2", "two.ts", secondPatch),
			fileChangeEnd("edit-2", "two.ts", secondPatch),
		]) {
			route(router, "thread-1", projector.project(event).notifications);
		}

		// Then: subscribers see exactly two cumulative diffs; the outsider sees none.
		const expectedDiffs = [firstPatch, `${firstPatch}${secondPatch}`];
		for (const subscriber of [first, second]) {
			const notifications = diffNotifications(subscriber);
			expect(notifications).toHaveLength(2);
			expect(notifications.map((notification) => notification.params)).toEqual([
				{ threadId: "thread-1", turnId: "turn-1", diff: expectedDiffs[0] },
				{ threadId: "thread-1", turnId: "turn-1", diff: expectedDiffs[1] },
			]);
			expect(notifications.map((notification) => notification.emittedAtMs)).toEqual([4242, 4242]);
		}
		expect(diffNotifications(outsider)).toEqual([]);
	});

	it("keeps a diff-less following turn silent", () => {
		// Given: a fresh projector for the next turn on the same thread.
		const recipient = new CapturingConnection("recipient");
		const router = new NotificationRouter({
			connections: [recipient],
			threads: [thread("thread-1", [recipient.id])],
		});
		const projector = new EventProjector({ threadId: "thread-1", turnId: "turn-2" });

		// When: the turn completes with assistant text and no file changes.
		const message = assistant([{ type: "text", text: "no files changed" }]);
		route(router, "thread-1", projector.project({ type: "message_end", message }).notifications);
		route(router, "thread-1", projector.finalize());

		// Then: no stale or fabricated turn diff is emitted.
		expect(diffNotifications(recipient)).toEqual([]);
	});
});
