import { describe, expect, it } from "vitest";
import { createExecuteTool } from "../src/extension/runtime-factory.ts";

// senpi#6391: a show_html_page call made from an eval cell is recorded only as part of the eval call, so the
// desktop, which renders a page from a top-level show_html_page call, never showed it, while the tool told the
// model the page was shown inline. Every kernel reaches host tools through createExecuteTool, so the refusal
// there covers the JS cell path and the py/rb/jl bridge alike.

function host() {
	const calls: string[] = [];
	const pi = {
		getActiveTools: () => ["eval", "read", "show_html_page"],
		getAllTools: () => [{ name: "eval" }, { name: "read" }, { name: "show_html_page", exposure: "search" }],
		executeTool: async (toolName: string) => {
			calls.push(toolName);
			return { content: [{ type: "text" as const, text: `ran ${toolName}` }], details: {} };
		},
	};
	return { pi, calls };
}

describe("senpi#6391: show_html_page from an eval cell", () => {
	it("is refused before it runs, with an error that tells the model to call it directly", async () => {
		const { pi, calls } = host();
		const executeTool = createExecuteTool(pi);
		await expect(executeTool("show_html_page", { html: "<p>x</p>", title: "x" }, {})).rejects.toThrow(
			/call show_html_page directly/,
		);
		expect(calls).toEqual([]);
	});

	it("leaves other tools callable from a cell", async () => {
		const { pi, calls } = host();
		const result = await createExecuteTool(pi)("read", { path: "/tmp/x" }, {});
		expect(result.content).toEqual([{ type: "text", text: "ran read" }]);
		expect(calls).toEqual(["read"]);
	});
});
