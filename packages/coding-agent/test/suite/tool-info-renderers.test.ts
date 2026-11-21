import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/sdk.ts";
import { createHarness } from "./harness.ts";

// Public extension API: getAllTools() carries a tool's own row renderers, so a host that draws the tool's calls
// elsewhere (codemode's nested tool.<name>() rows) draws them like the direct row (oh-my-openagent#12994).
const renderCall = () => ({ render: () => ["call"], invalidate: () => {} });
const renderResult = () => ({ render: () => ["result"], invalidate: () => {} });

const tools: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "drawn",
		label: "Drawn",
		description: "Tool with its own row",
		parameters: Type.Object({}),
		renderCall,
		renderResult,
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	});
	pi.registerTool({
		name: "plain",
		label: "Plain",
		description: "Tool without renderers",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	});
};

describe("getAllTools row renderers", () => {
	it("projects a tool's renderCall and renderResult, and leaves both absent for a tool without them", async () => {
		// Given
		const harness = await createHarness({ extensionFactories: [tools] });
		try {
			// When
			const all = harness.session.getAllTools();
			const drawn = all.find((tool) => tool.name === "drawn");
			const plain = all.find((tool) => tool.name === "plain");

			// Then
			expect(drawn?.renderCall).toBe(renderCall);
			expect(drawn?.renderResult).toBe(renderResult);
			expect(plain).toBeDefined();
			expect(plain && "renderCall" in plain).toBe(false);
			expect(plain && "renderResult" in plain).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});
