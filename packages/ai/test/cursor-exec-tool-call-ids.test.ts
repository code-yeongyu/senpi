import { describe, expect, it } from "vitest";
import { ensureUniqueCursorExecToolCallId } from "../src/api/cursor-agent.ts";
import type { AssistantMessage } from "../src/types.ts";

function assistantWithToolCallIds(ids: string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: {} })),
		timestamp: Date.now(),
	} as AssistantMessage;
}

// Cursor reuses one parent tool-call id across compound-tool exec frames
// (StrReplace → read + write); ids must be uniquified before synthesis or the
// persisted transcript bricks Anthropic resumes.
describe("ensureUniqueCursorExecToolCallId", () => {
	it("keeps an id that is not yet used in the assistant message", () => {
		const args = { toolCallId: "StrReplace_0_aa-1" };
		ensureUniqueCursorExecToolCallId(assistantWithToolCallIds([]), args);
		expect(args.toolCallId).toBe("StrReplace_0_aa-1");
	});

	it("mints an id when the frame carries none", () => {
		const args: { toolCallId?: string } = {};
		ensureUniqueCursorExecToolCallId(assistantWithToolCallIds([]), args);
		expect(args.toolCallId).toBeTruthy();
	});

	it("suffixes an id already used by a synthesized block", () => {
		const args = { toolCallId: "StrReplace_0_aa-1" };
		ensureUniqueCursorExecToolCallId(assistantWithToolCallIds(["StrReplace_0_aa-1"]), args);
		expect(args.toolCallId).toBe("StrReplace_0_aa-1-2");
	});

	it("skips suffixes that are themselves taken", () => {
		const args = { toolCallId: "id-1" };
		ensureUniqueCursorExecToolCallId(assistantWithToolCallIds(["id-1", "id-1-2"]), args);
		expect(args.toolCallId).toBe("id-1-3");
	});
});
