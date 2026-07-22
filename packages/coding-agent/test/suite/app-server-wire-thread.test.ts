import { describe, expect, it } from "vitest";
import { TurnLog, type WireItem } from "../../src/modes/app-server/threads/turn-log.ts";
import { loggedTurnToWireTurn, wireItemToThreadItem } from "../../src/modes/app-server/threads/wire-thread.ts";

describe("app-server wire thread history", () => {
	it("preserves every projected thread item variant", () => {
		// Given: completed items produced by every non-message projector variant.
		const items: readonly WireItem[] = [
			{
				type: "commandExecution",
				id: "command-1",
				command: "pwd",
				cwd: "/tmp",
				processId: null,
				source: "agent",
				status: "completed",
				commandActions: [],
				aggregatedOutput: "/tmp",
				exitCode: 0,
				durationMs: 12,
			},
			{ type: "fileChange", id: "file-1", changes: [], status: "completed" },
			{
				type: "mcpToolCall",
				id: "mcp-1",
				server: "fixture",
				tool: "echo",
				status: "completed",
				arguments: { value: "ok" },
				appContext: null,
				pluginId: null,
				result: { content: [], structuredContent: null, _meta: null },
				error: null,
				durationMs: 7,
			},
			{
				type: "dynamicToolCall",
				id: "dynamic-1",
				namespace: null,
				tool: "fixture",
				arguments: { value: true },
				status: "completed",
				contentItems: [{ type: "inputText", text: "ok" }],
				success: true,
				durationMs: 5,
			},
			{ type: "webSearch", id: "web-1", query: "senpi", action: null },
			{ type: "contextCompaction", id: "compact-1" },
		];

		// When: logged wire items are reconstructed for thread history.
		const reconstructed = items.map(wireItemToThreadItem);

		// Then: no projected variant or variant-specific field is collapsed into agentMessage.
		expect(reconstructed).toEqual(items);
	});

	it("persists completed-turn lifecycle data into wire history", () => {
		// Given: a running turn with a known start time.
		const turnLog = new TurnLog();
		turnLog.recordTurn("thread-1", {
			turnId: "turn-1",
			startedAt: "2026-07-20T00:00:00.000Z",
		});

		// When: the turn fails at a known completion time with a concrete error.
		turnLog.completeTurn("thread-1", "turn-1", {
			status: "failed",
			completedAt: "2026-07-20T00:00:01.250Z",
			error: "scripted failure",
		});
		const logged = turnLog.readTurns("thread-1")[0];
		if (!logged) throw new Error("missing logged turn");
		const wire = loggedTurnToWireTurn(logged);

		// Then: history retains the same terminal status, error, completion time, and duration.
		expect(wire).toMatchObject({
			status: "failed",
			error: {
				message: "scripted failure",
				codexErrorInfo: "other",
				additionalDetails: null,
			},
			startedAt: 1_784_505_600,
			completedAt: 1_784_505_601.25,
			durationMs: 1_250,
		});
	});
});
