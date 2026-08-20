import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	CURSOR_TOOL_RESULT_MAX_CHARS,
	truncateToolResultBodies,
} from "../../../src/core/agent-session.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function textMessage(role: AgentMessage["role"], text: string): AgentMessage {
	return { role, content: [{ type: "text", text }] } as AgentMessage;
}

describe("1043 cursor toolResult truncate", () => {
	it("caps long toolResult text and leaves other roles", () => {
		const messages = [
			textMessage("user", "진행해"),
			textMessage("assistant", "ok".repeat(5000)),
			textMessage("toolResult", "x".repeat(40_000)),
		];
		const { messages: next, changed } = truncateToolResultBodies(messages, 2000);
		expect(changed).toBe(true);
		expect(next?.[0].content).toEqual([{ type: "text", text: "진행해" }]);
		expect((next?.[1].content[0] as { text: string }).text.length).toBe(10_000);
		const toolText = (next?.[2].content[0] as { text: string }).text;
		expect(toolText.startsWith("x".repeat(2000))).toBe(true);
		expect(toolText.length).toBeLessThanOrEqual(2000 + 32);
		expect(toolText.length).not.toBe(40_000);
	});

	it("is a no-op when every toolResult is already short", () => {
		const messages = [textMessage("toolResult", "ok")];
		const { changed } = truncateToolResultBodies(messages, CURSOR_TOOL_RESULT_MAX_CHARS);
		expect(changed).toBe(false);
	});

	it("Cursor admission truncates before the compact skip return", () => {
		const src = readFileSync(join(import.meta.dirname, "../../../src/core/agent-session.ts"), "utf8");
		const start = src.indexOf("const compactBeforeNextAdmission = async");
		expect(start).toBeGreaterThanOrEqual(0);
		const slice = src.slice(start, start + 1800);
		const truncateAt = slice.indexOf("_truncateCursorToolResultBodies");
		const skipAt = slice.indexOf("return truncated");
		expect(truncateAt).toBeGreaterThanOrEqual(0);
		expect(skipAt).toBeGreaterThan(truncateAt);
	});

	it("re-truncates after compact reloads sessionContext.messages", () => {
		const src = readFileSync(join(import.meta.dirname, "../../../src/core/agent-session.ts"), "utf8");
		const assign = "this.agent.state.messages = [...sessionContext.messages, ...preservedPendingMessages];";
		const i = src.indexOf(assign);
		expect(i).toBeGreaterThanOrEqual(0);
		expect(src.slice(i, i + 400)).toContain("_reapplyCursorToolTruncateAfterReload");
	});
});
