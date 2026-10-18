import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";

// senpi#1870 / senpi#2042: history must project the same ordered components as the live event path.
describe("exploration replay", () => {
	for (const hidden of [true, false]) {
		it(`matches live text/tool order with thinking ${hidden ? "hidden" : "visible"}`, async () => {
			const live = await explorationSurface(hidden);
			const replay = await explorationSurface(hidden);
			try {
				const first = {
					type: "toolCall",
					id: "a",
					name: "read",
					arguments: { path: "a.ts", offset: 1, limit: 4 },
				} as const;
				const second = {
					type: "toolCall",
					id: "b",
					name: "read",
					arguments: { path: "b.ts", offset: 5, limit: 4 },
				} as const;
				const message: AssistantMessage = {
					...fauxAssistantMessage(""),
					content: [
						first,
						{ type: "thinking", thinking: "Intermediate reasoning" },
						second,
						{ type: "text", text: "Trailing answer" },
					],
					stopReason: "toolUse",
				};
				await live.event({ type: "message_start", message });
				await live.event({
					type: "message_update",
					message,
					assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, toolCall: second, partial: message },
				});
				await live.event({ type: "message_end", message });
				const results: ToolResultMessage[] = [first, second].map((call) => ({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: `result-${call.id}` }],
					isError: false,
					timestamp: 0,
				}));
				for (const result of results)
					await live.event({
						type: "tool_execution_end",
						toolCallId: result.toolCallId,
						toolName: result.toolName,
						result,
						isError: false,
					});
				invoke(replay.mode, "renderSessionItems", [message, ...results]);
				for (const expanded of [false, true]) {
					invoke(live.mode, "setToolsExpanded", expanded);
					invoke(replay.mode, "setToolsExpanded", expanded);
					for (const width of [80, 120]) expect(replay.text(width)).toBe(live.text(width));
				}
			} finally {
				live.cleanup();
				replay.cleanup();
			}
		});
	}
});
