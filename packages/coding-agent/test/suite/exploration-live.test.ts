import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";

// senpi#1870: exercise the existing interactive event seam, not a new renderer in isolation.
describe("exploration through interactive events", () => {
	it("groups consecutive reads with requested ranges while expansion restores original results", async () => {
		const surface = await explorationSurface();
		try {
			const calls: ToolCall[] = [1, 201, 401].map((offset, index) => ({
				type: "toolCall",
				id: `read-${index}`,
				name: "read",
				arguments: { path: "src/sample.ts", offset, limit: 200 },
			}));
			const search: ToolCall = {
				type: "toolCall",
				id: "search",
				name: "grep",
				arguments: { pattern: "sample", path: "src" },
			};
			calls.push(search);
			const message: AssistantMessage = { ...fauxAssistantMessage(""), content: calls, stopReason: "toolUse" };
			await surface.event({ type: "message_start", message });
			await surface.event({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_end", contentIndex: 3, toolCall: search, partial: message },
			});
			await surface.event({ type: "message_end", message });
			for (const call of calls) {
				if (call.type !== "toolCall") continue;
				await surface.event({
					type: "tool_execution_start",
					toolCallId: call.id,
					toolName: call.name,
					args: call.arguments,
				});
				await surface.event({
					type: "tool_execution_end",
					toolCallId: call.id,
					toolName: call.name,
					result: { content: [{ type: "text", text: `original-result-${call.id}` }] },
					isError: false,
				});
			}
			const answer = fauxAssistantMessage("Answer after exploration");
			await surface.event({ type: "message_start", message: answer });
			await surface.event({ type: "message_end", message: answer });

			const compact = surface.text();
			expect(compact.match(/src\/sample\.ts/g)).toHaveLength(1);
			expect(compact).toContain("3 reads");
			expect(compact).toContain("requested 1-600");
			expect(compact).toContain("Search");
			expect(compact).toContain("Answer after exploration");
			expect(compact.indexOf("Search")).toBeLessThan(compact.indexOf("Answer after exploration"));
			invoke(surface.mode, "setToolsExpanded", true);
			const expanded = surface.text();
			for (const range of ["1-200", "201-400", "401-600"]) expect(expanded).toContain(range);
			for (const id of ["read-0", "read-1", "read-2", "search"]) expect(expanded).toContain(`original-result-${id}`);
			expect(Reflect.get(surface.mode, "pendingTools").size).toBe(0);
		} finally {
			surface.cleanup();
		}
	});
});
