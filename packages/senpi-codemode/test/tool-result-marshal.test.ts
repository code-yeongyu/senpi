import { describe, expect, it } from "vitest";
import { marshalToolResult } from "../src/tool/image.ts";

describe("marshalToolResult", () => {
	it("Given a model-only placeholder when marshalled then .text is empty (senpi#7209)", () => {
		const reply = marshalToolResult({
			content: [{ type: "text", text: "(no output)", audience: "model" }],
			details: { status: "exit 0" },
		});
		expect(reply.text).toBe("");
	});

	it("Given visible output and a model-only notice when marshalled then .text holds only the visible output", () => {
		const reply = marshalToolResult({
			content: [
				{ type: "text", text: "line 1\nline 2" },
				{ type: "text", text: "[earlier output dropped]", audience: "model" },
			],
			details: {},
		});
		expect(reply).toEqual({ text: "line 1\nline 2" });
	});
});
