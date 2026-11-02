import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "../../src/index.ts";
import { createHarness } from "../suite/harness.ts";

function tool(name: string, exposure: "direct" | "search" = "direct"): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} description`,
		exposure,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: `${name}-ran` }], details: {} }),
	};
}

async function createExtensionHarness(
	register: (pi: ExtensionAPI) => void,
	options: { initialActiveToolNames?: string[]; allowedToolNames?: string[] } = {},
) {
	let api: ExtensionAPI | undefined;
	const extensionFactories: ExtensionFactory[] = [
		(pi) => {
			api = pi;
			register(pi);
		},
	];
	const harness = await createHarness({ extensionFactories, ...options });
	return { ...harness, api: api as ExtensionAPI };
}

describe("search-exposed tool activation gating", () => {
	it("registers factory search tools without exposing them to the model", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool(tool("search_only", "search"));
					pi.registerTool(tool("direct_tool"));
				},
			],
		});

		try {
			expect(harness.session.getAllTools().map(({ name }) => name)).toContain("search_only");
			expect(harness.session.getActiveToolNames()).not.toContain("search_only");
			expect(harness.session.getActiveToolNames()).toContain("direct_tool");
			expect(harness.agent.state.tools.map(({ name }) => name)).not.toContain("search_only");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps a search tool registered after post-bind registration but inactive", async () => {
		const harness = await createExtensionHarness(() => {});
		try {
			harness.api.registerTool(tool("late_search", "search"));
			expect(harness.session.getAllTools().map(({ name }) => name)).toContain("late_search");
			expect(harness.session.getActiveToolNames()).not.toContain("late_search");
		} finally {
			harness.cleanup();
		}
	});

	it("honors explicit initial active names for search tools", async () => {
		const harness = await createExtensionHarness((pi) => pi.registerTool(tool("explicit_search", "search")), {
			initialActiveToolNames: ["explicit_search"],
		});
		try {
			expect(harness.session.getActiveToolNames()).toContain("explicit_search");
		} finally {
			harness.cleanup();
		}
	});

	it("treats allowed names as an authoritative host override", async () => {
		const harness = await createExtensionHarness(
			(pi) => {
				pi.registerTool(tool("allowed_search", "search"));
				pi.registerTool(tool("not_allowed_direct"));
			},
			{ allowedToolNames: ["allowed_search"] },
		);
		try {
			expect(harness.session.getActiveToolNames()).toEqual(["allowed_search"]);
		} finally {
			harness.cleanup();
		}
	});
});
