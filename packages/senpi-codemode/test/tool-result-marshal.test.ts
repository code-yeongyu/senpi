import { describe, expect, it } from "vitest";
import { toolCallResultPreview } from "../src/tool/call-capture.ts";
import { marshalToolResult } from "../src/tool/image.ts";

const EMPTY_OUTPUT_PLACEHOLDER = { type: "text", text: "(no output)", audience: "model" } as const;

describe("marshalToolResult", () => {
	it("Given the empty-output placeholder when marshalled then .text is empty (senpi#7209)", () => {
		const reply = marshalToolResult({ content: [EMPTY_OUTPUT_PLACEHOLDER], details: { status: "exit 0" } });

		expect(reply.text).toBe("");
	});

	it("Given a read with injected AGENTS.md and project rules when marshalled then .text keeps that context", () => {
		const reply = marshalToolResult({
			content: [
				{ type: "text", text: "file body" },
				{ type: "text", text: "<nested-agents>sub/AGENTS.md</nested-agents>", audience: "model" },
				{ type: "text", text: "<project-rules>rule</project-rules>", audience: "model" },
			],
			details: {},
		});

		expect(reply).toEqual({
			text: "file body\n<nested-agents>sub/AGENTS.md</nested-agents>\n<project-rules>rule</project-rules>",
		});
	});

	it("Given visible output and a model-only notice when marshalled then .text keeps both", () => {
		const reply = marshalToolResult({
			content: [
				{ type: "text", text: "line 1\nline 2" },
				{ type: "text", text: "[earlier output dropped]", audience: "model" },
			],
			details: {},
		});

		expect(reply).toEqual({ text: "line 1\nline 2\n[earlier output dropped]" });
	});
});

describe("toolCallResultPreview", () => {
	it("Given only the empty-output placeholder when previewed then there is no preview line", () => {
		expect(toolCallResultPreview({ content: [EMPTY_OUTPUT_PLACEHOLDER], details: {} })).toBeUndefined();
	});

	it("Given injected context before visible output when previewed then the preview shows the output", () => {
		const preview = toolCallResultPreview({
			content: [
				{ type: "text", text: "<nested-agents>context</nested-agents>", audience: "model" },
				{ type: "text", text: "visible" },
			],
			details: {},
		});

		expect(preview).toBe("visible");
	});
});
