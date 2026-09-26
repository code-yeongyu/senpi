import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { KernelPreludeCollisionError } from "../../src/core/extensions/kernel-prelude.ts";
import type { KernelPreludeContribution } from "../../src/core/extensions/types.ts";
import type { ExtensionFactory } from "../../src/core/sdk.ts";
import { createHarness } from "./harness.ts";

const FIXTURE_PRELUDE: KernelPreludeContribution = {
	javascript: "globalThis.fx = { windows: async () => await tool.fx({}) };",
	python: "class _Fx:\n    def windows(self):\n        return tool.fx({})\nfx = _Fx()",
	documentation: "fx.windows() -> fixture windows",
	exports: ["fx"],
};

function fixtureToolExtension(prelude: KernelPreludeContribution): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "fx",
			label: "Fixture",
			description: "Fixture tool with kernel globals",
			parameters: Type.Object({}),
			kernelPrelude: prelude,
			execute: async () => ({ content: [{ type: "text", text: "fx" }], details: {} }),
		});
	};
}

describe("ToolDefinition.kernelPrelude projection", () => {
	it("projects a registered tool's kernelPrelude through getAllTools", async () => {
		// Given
		const harness = await createHarness({ extensionFactories: [fixtureToolExtension(FIXTURE_PRELUDE)] });
		try {
			// When
			const projected = harness.session.getAllTools().find((tool) => tool.name === "fx");

			// Then
			expect(projected?.kernelPrelude).toEqual(FIXTURE_PRELUDE);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects an export that shadows a built-in kernel global, naming the collision", async () => {
		// Given
		const colliding = { ...FIXTURE_PRELUDE, exports: ["fx", "display"] };
		const harness = await createHarness({ extensionFactories: [fixtureToolExtension(colliding)] });
		try {
			// When
			const project = () => harness.session.getAllTools();

			// Then
			expect(project).toThrow(KernelPreludeCollisionError);
			expect(project).toThrow(/"fx".*"display"/);
		} finally {
			harness.cleanup();
		}
	});
});
