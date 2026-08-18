import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "../../src/index.ts";
import { createHarness } from "../suite/harness.ts";

function tool(name: string, allowLazyActivation?: boolean): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} description`,
		allowLazyActivation,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: `${name}-ran` }], details: {} }),
	};
}

async function harnessWith(factory: (pi: ExtensionAPI) => void) {
	let api: ExtensionAPI | undefined;
	const extensionFactories: ExtensionFactory[] = [
		(pi) => {
			api = pi;
			factory(pi);
		},
	];
	const harness = await createHarness({ extensionFactories });
	return { ...harness, api: api as ExtensionAPI };
}

describe("allowLazyActivation hard stop", () => {
	it("returns inactive_tool without invoking activators when lazy activation is disabled", async () => {
		const activator = vi.fn(() => true);
		const harness = await harnessWith((pi) => {
			pi.registerTool(tool("lazy_blocked", false));
			pi.registerLazyToolActivator(activator);
		});
		try {
			harness.session.setActiveToolsByName(["read"]);
			await expect(
				harness.api.executeTool("lazy_blocked", {}, { activateInactiveTool: true }),
			).rejects.toMatchObject({ code: "inactive_tool" });
			expect(activator).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
		}
	});

	it("keeps lazy activation enabled by default", async () => {
		const activator = vi.fn<(name: string) => boolean>();
		const harness = await harnessWith((pi) => {
			pi.registerTool(tool("lazy_default"));
			activator.mockImplementation((name) => {
				if (name !== "lazy_default") return false;
				pi.setActiveTools([...pi.getActiveTools(), name]);
				return true;
			});
			pi.registerLazyToolActivator(activator);
		});
		try {
			harness.session.setActiveToolsByName(["read"]);
			const result = await harness.api.executeTool("lazy_default", {}, { activateInactiveTool: true });
			expect(activator).toHaveBeenCalledWith("lazy_default");
			expect(JSON.stringify(result.content)).toContain("lazy_default-ran");
		} finally {
			harness.cleanup();
		}
	});

	it("allows explicit activation of a tool that disables lazy activation", async () => {
		const activator = vi.fn(() => true);
		const harness = await harnessWith((pi) => {
			pi.registerTool(tool("explicit_only", false));
			pi.registerLazyToolActivator(activator);
		});
		try {
			harness.session.setActiveToolsByName(["read"]);
			harness.api.setActiveTools([...harness.api.getActiveTools(), "explicit_only"]);
			const result = await harness.api.executeTool("explicit_only", {}, { activateInactiveTool: true });
			expect(activator).not.toHaveBeenCalled();
			expect(JSON.stringify(result.content)).toContain("explicit_only-ran");
		} finally {
			harness.cleanup();
		}
	});
});
