import { describe, expect, it } from "vitest";
import { createIdMapper } from "../../src/core/extensions/builtin/pi-codex-app-server/id-mapper.ts";
import { createNotificationProjector } from "../../src/core/extensions/builtin/pi-codex-app-server/notification-projector.ts";
import { createSessionRegistry } from "../../src/core/extensions/builtin/pi-codex-app-server/session-registry.ts";

function createBoundProjector() {
	const sessionRegistry = createSessionRegistry();
	const idMapper = createIdMapper();
	const bindResult = sessionRegistry.bindSession({
		externalSessionId: "external-session-1",
		appThreadId: "app-thread-1",
		appSessionId: "app-session-1",
	});
	expect(bindResult.kind).toBe("bound");
	const projector = createNotificationProjector({
		connectionId: "connection-1",
		capabilityFlags: ["semantic-events", "opaque-notifications"],
		notificationOptOuts: [],
		idMapper,
		sessionRegistry,
	});
	return { idMapper, projector };
}

describe("pi-codex-app-server notification and item stream projection", () => {
	it("projects text, plan, reasoning, and completed item streams as separate lossless channels", () => {
		const { idMapper, projector } = createBoundProjector();

		const started = projector.project({
			method: "item/started",
			params: {
				thread_id: "app-thread-1",
				turn_id: "app-turn-1",
				item: { id: "app-item-1", type: "agentMessage" },
			},
		});
		const text = projector.project({
			method: "item/agentMessage/delta",
			params: {
				thread_id: "app-thread-1",
				turn_id: "app-turn-1",
				item_id: "app-item-1",
				delta: "Hello",
			},
		});
		const plan = projector.project({
			method: "item/plan/delta",
			params: {
				thread_id: "app-thread-1",
				turn_id: "app-turn-1",
				item_id: "app-item-1",
				delta: "- inspect routing",
			},
		});
		const reasoning = projector.project({
			method: "item/reasoning/summaryTextDelta",
			params: {
				thread_id: "app-thread-1",
				turn_id: "app-turn-1",
				item_id: "app-item-1",
				delta: "Need IDs",
				index: 0,
			},
		});
		const completed = projector.project({
			method: "item/completed",
			params: {
				thread_id: "app-thread-1",
				turn_id: "app-turn-1",
				item: { id: "app-item-1", type: "agentMessage", text: "Hello" },
			},
		});

		expect([started, text, plan, reasoning, completed]).toMatchObject([
			{
				kind: "semantic",
				sequence: 1,
				channel: "item",
				semanticType: "item-started",
				streamClass: "lossless",
				externalSessionId: "external-session-1",
				appThreadId: "app-thread-1",
				appTurnId: "app-turn-1",
				appItemId: "app-item-1",
			},
			{
				kind: "semantic",
				sequence: 2,
				channel: "text",
				semanticType: "delta",
				streamClass: "lossless",
				delta: "Hello",
			},
			{
				kind: "semantic",
				sequence: 3,
				channel: "plan",
				semanticType: "delta",
				streamClass: "lossless",
				delta: "- inspect routing",
			},
			{
				kind: "semantic",
				sequence: 4,
				channel: "reasoning-summary",
				semanticType: "delta",
				streamClass: "lossless",
				delta: "Need IDs",
				index: 0,
			},
			{
				kind: "semantic",
				sequence: 5,
				channel: "item",
				semanticType: "item-completed",
				streamClass: "lossless",
				completedItem: { id: "app-item-1", type: "agentMessage", text: "Hello" },
			},
		]);
		expect(idMapper.getItem("app-item-1")).toMatchObject({
			appThreadId: "app-thread-1",
			appTurnId: "app-turn-1",
			appItemId: "app-item-1",
			itemKind: "agentMessage",
		});
	});

	it("emits lossless opaque envelopes for notifications without a first-class projection", () => {
		const { projector } = createBoundProjector();

		const projected = projector.project({
			method: "warning",
			params: {
				thread_id: "app-thread-1",
				message: "model warning",
			},
		});

		expect(projected).toMatchObject({
			kind: "opaque",
			method: "appServer/event",
			envelope: {
				protocolVersion: "2026-06-24.pr-001",
				connectionId: "connection-1",
				externalSessionId: "external-session-1",
				appThreadId: "app-thread-1",
				sequence: 1,
				streamClass: "lossless",
				capabilityFlags: ["semantic-events", "opaque-notifications"],
				originalMethod: "warning",
				originalParams: {
					thread_id: "app-thread-1",
					message: "model warning",
				},
				redactionClass: "public-contract",
			},
		});
	});

	it("skips negotiated notification opt-outs before projection", () => {
		const sessionRegistry = createSessionRegistry();
		const idMapper = createIdMapper();
		const projector = createNotificationProjector({
			connectionId: "connection-1",
			capabilityFlags: ["opaque-notifications"],
			notificationOptOuts: ["thread/tokenUsage/updated"],
			idMapper,
			sessionRegistry,
		});

		const projected = projector.project({
			method: "thread/tokenUsage/updated",
			params: {
				thread_id: "app-thread-1",
				total_tokens: 42,
			},
		});

		expect(projected).toEqual({ kind: "skipped", reason: "notification-opt-out" });
	});

	it("classifies command, process, file, and MCP progress as best-effort semantic progress", () => {
		const { projector } = createBoundProjector();

		const command = projector.project({
			method: "item/commandExecution/outputDelta",
			params: {
				thread_id: "app-thread-1",
				turn_id: "app-turn-1",
				item_id: "app-command-1",
				stream: "stdout",
				delta: "line",
			},
		});
		const process = projector.project({
			method: "process/outputDelta",
			params: {
				thread_id: "app-thread-1",
				turn_id: "app-turn-1",
				item_id: "app-process-1",
				delta: "chunk",
			},
		});
		const file = projector.project({
			method: "item/fileChange/patchUpdated",
			params: {
				thread_id: "app-thread-1",
				turn_id: "app-turn-1",
				item_id: "app-file-1",
				patch: "*** Begin Patch",
			},
		});
		const mcp = projector.project({
			method: "item/mcpToolCall/progress",
			params: {
				thread_id: "app-thread-1",
				turn_id: "app-turn-1",
				item_id: "app-mcp-1",
				message: "running",
			},
		});

		expect([command, process, file, mcp]).toMatchObject([
			{ kind: "semantic", channel: "command", semanticType: "progress", streamClass: "best-effort" },
			{ kind: "semantic", channel: "process", semanticType: "progress", streamClass: "best-effort" },
			{ kind: "semantic", channel: "file", semanticType: "progress", streamClass: "best-effort" },
			{ kind: "semantic", channel: "mcp", semanticType: "progress", streamClass: "best-effort" },
		]);
	});
});
