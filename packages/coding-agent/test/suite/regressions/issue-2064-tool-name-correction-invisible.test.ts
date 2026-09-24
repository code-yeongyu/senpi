import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { explorationSurface, invoke } from "../exploration-surface-harness.ts";

const TRANSCRIPT_EVENTS = new Set([
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

// #2064: a call whose name the agent resolves (gateway namespace, recasing) must look to the user
// exactly like a direct call to the resolved tool; only the model hears about the correction.
describe("tool-name correction is invisible to the user", () => {
	it("renders a resolved mcp__<id>__Read call as a plain read, live and on replay", async () => {
		const live = await explorationSurface();
		const replay = await explorationSurface();
		try {
			const file = join(live.harness.tempDir, "sample.ts");
			writeFileSync(file, "export const answer = 42;\n");
			live.harness.setResponses([
				fauxAssistantMessage(fauxToolCall("mcp__686f__Read", { path: file }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await live.harness.session.prompt("read it");

			expect(live.harness.eventsOfType("tool_execution_start").map((event) => event.toolName)).toEqual(["read"]);
			const result = live.harness.session.messages.find(
				(message): message is ToolResultMessage => message.role === "toolResult",
			);
			expect(result?.toolName).toBe("read");
			expect(result?.content[0]).toEqual({
				type: "text",
				text: '[auto-corrected] no tool is named "mcp__686f__Read"; ran "read". Call tools by their exact listed name.',
				audience: "model",
			});

			for (const event of live.harness.events) {
				if (TRANSCRIPT_EVENTS.has(event.type)) await live.event(event);
			}
			invoke(replay.mode, "renderSessionItems", live.harness.session.messages);

			for (const surface of [live, replay]) {
				const compact = surface.text();
				expect(compact).toContain("Read sample.ts");
				invoke(surface.mode, "setToolsExpanded", true);
				const expanded = surface.text();
				expect(expanded).toContain("export const answer = 42;");
				for (const text of [compact, expanded]) {
					expect(text).not.toContain("mcp__686f__");
					expect(text).not.toContain("auto-corrected");
				}
			}
		} finally {
			live.cleanup();
			replay.cleanup();
		}
	});
});
