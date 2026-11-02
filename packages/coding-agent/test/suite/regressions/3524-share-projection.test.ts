import { describe, expect, it } from "vitest";
import { newOutputOmissions, omitToolOutputs } from "../../../src/core/share/share-projection.ts";

// senpi#3524: /share leaves every tool output out by default; tool names and call arguments stay.

const session = {
	entries: [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "read .env" }] } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: ".env" } }],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "text", text: "A=1" }],
				details: { lines: 1 },
			},
		},
		{ type: "message", message: { role: "bashExecution", command: "env", output: "A=1", fullOutputPath: "/tmp/x" } },
		{ type: "custom_message", customType: "goal", content: "goal text", details: { x: 1 }, display: true },
		{ type: "custom", customType: "state", data: { secret: "s" } },
	],
	renderedTools: { c1: { callHtml: "<b>read .env</b>", resultHtmlCollapsed: "A=1", resultHtmlExpanded: "A=1" } },
};

describe("default share projection (senpi#3524)", () => {
	it("replaces every tool output with a note and keeps the conversation and tool calls", () => {
		const omissions = newOutputOmissions();
		const projected = omitToolOutputs(session, omissions);
		const text = JSON.stringify(projected);

		expect(text).not.toContain("A=1");
		expect(text).not.toContain("/tmp/x");
		expect(text).not.toContain("goal text");
		expect(text).not.toContain('"secret"');
		expect(text).toContain("read .env");
		expect(text).toContain('"arguments":{"path":".env"}');
		expect(text).toContain("[output omitted: read]");
		expect(text).toContain("[output omitted: command]");
		expect(text).toContain("[output omitted: goal]");
		expect(projected.renderedTools).toEqual({ c1: { callHtml: "<b>read .env</b>" } });
		expect(omissions.count).toBe(3);
	});

	it("is idempotent, and every pass counts the same outputs", () => {
		const first = newOutputOmissions();
		const once = omitToolOutputs(session, first);
		const second = newOutputOmissions();
		const twice = omitToolOutputs(once, second);
		expect(twice).toEqual(once);
		expect([first.count, second.count]).toEqual([3, 3]);
	});

	it("counts two outputs that share a timestamp separately", () => {
		const result = (id: string) => ({
			type: "message",
			message: { role: "toolResult", toolCallId: id, toolName: "read", content: [], timestamp: 7 },
		});
		const omissions = newOutputOmissions();
		omitToolOutputs([result("a"), result("b")], omissions);
		expect(omissions.count).toBe(2);
	});

	it("replaces output that merely starts like an omission note, details included", () => {
		const marker = ["FORGED", "MARKER", "3524"].join("-");
		const forged = {
			entries: [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "c9",
						toolName: "read",
						content: [{ type: "text", text: `[output omitted: read] ${marker}` }],
						details: { leaked: marker },
					},
				},
				{
					type: "message",
					message: {
						role: "bashExecution",
						command: "cat",
						output: `[output omitted: x] ${marker}`,
						timestamp: 1,
					},
				},
			],
		};
		const omissions = newOutputOmissions();
		const text = JSON.stringify(omitToolOutputs(forged, omissions));
		expect(text).not.toContain(marker);
		expect(omissions.count).toBe(2);
	});

	it("drops compaction and branch-summary extension data and context-edit replacements", () => {
		const marker = ["EXT", "DATA", "3524"].join("-");
		const entries = [
			{ type: "compaction", summary: "kept summary", details: { marker }, systemMessage: { content: marker } },
			{ type: "branch_summary", summary: "kept branch", details: { marker } },
			{ type: "context_edit", targetId: "t1", replacement: { content: [{ type: "text", text: marker }] } },
			{ type: "context_edit", targetId: "t2", replacement: null },
		];
		const omissions = newOutputOmissions();
		const projected = omitToolOutputs(entries, omissions);
		const text = JSON.stringify(projected);
		expect(text).not.toContain(marker);
		expect(text).toContain("kept summary");
		expect(text).toContain("kept branch");
		expect(text).toContain("[output omitted: context edit]");
		expect(projected[3]).toEqual(entries[3]);
		expect(omissions.count).toBe(1);
	});
});
