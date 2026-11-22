import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createToolSearchExtension, ToolSearchService } from "../../src/core/extensions/builtin/tool-search/index.ts";
import type { ResourceLoader } from "../../src/core/resource-loader.ts";
import type { ExtensionFactory, LoadExtensionsResult, ToolDefinition } from "../../src/index.ts";
import { createHarness } from "../suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

function searchTool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} description`,
		exposure: "search",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: `${name}-ran` }], details: {} }),
	};
}

async function extensionResult(path: string, register: (pi: Parameters<ExtensionFactory>[0]) => void) {
	return createTestExtensionsResult([{ path, factory: register }]);
}

function mutableResourceLoader(
	initial: LoadExtensionsResult,
	reloadTo: () => Promise<LoadExtensionsResult>,
): ResourceLoader {
	let current = initial;
	return {
		...createTestResourceLoader(),
		getExtensions: () => current,
		reload: async () => {
			current = await reloadTo();
		},
	};
}

function promote(
	session: { getActiveToolNames(): string[]; setActiveToolsByName(names: string[]): void },
	name: string,
) {
	session.setActiveToolsByName([...session.getActiveToolNames(), name]);
}

describe("owner-aware active tool continuity across reload", () => {
	// Regression: omo#9365. Computer shutdown deactivates its deferred tool before reload rebuilds it.
	it.each([1, 3])("executes a deferred tool through the current generation after %i reloads", async (reloads) => {
		// Given: each load owns a real catalog service and a tool using its generation's API.
		let generation = 0;
		const load = () =>
			createTestExtensionsResult([
				{
					path: "<builtin:tool-search>",
					factory: (pi) => createToolSearchExtension(new ToolSearchService(pi))(pi),
				},
				{
					path: "/extensions/computer.ts",
					factory: (pi) => {
						const current = ++generation;
						pi.registerTool({
							...searchTool("computer"),
							execute: async () => ({
								content: [
									{ type: "text", text: JSON.stringify({ generation: current, tools: pi.getActiveTools() }) },
								],
								details: { generation: current },
							}),
						});
						pi.on("session_shutdown", () =>
							pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "computer")),
						);
					},
				},
			]);
		const harness = await createHarness({ resourceLoader: mutableResourceLoader(await load(), load) });
		try {
			await harness.session.executeTool("computer", { action: "capabilities" }, { activateInactiveTool: true });
			// When: shutdown retires activation and reload replaces the extension generation.
			for (let index = 0; index < reloads; index++) await harness.session.reload();
			const result = await harness.session.executeTool(
				"computer",
				{ action: "capabilities" },
				{ activateInactiveTool: true },
			);
			// Then: the tool executes with the replacement API, rather than a stale catalog.
			expect(result.details).toEqual({ generation: reloads + 1 });
		} finally {
			harness.cleanup();
		}
	});

	it("refuses lazy activation when the replacement tool disables it", async () => {
		// Given: the replacement generation changes a deferred tool to explicit activation only.
		const owner = "/extensions/guarded.ts";
		const initial = await extensionResult(owner, (pi) => pi.registerTool(searchTool("guarded")));
		const loader = mutableResourceLoader(initial, () =>
			extensionResult(owner, (pi) => pi.registerTool({ ...searchTool("guarded"), allowLazyActivation: false })),
		);
		const harness = await createHarness({ resourceLoader: loader });
		try {
			await harness.session.reload();
			// When: a caller requests lazy activation after reload.
			const result = harness.session.executeTool("guarded", {}, { activateInactiveTool: true });
			// Then: the current generation's activation policy refuses execution.
			await expect(result).rejects.toMatchObject({ code: "inactive_tool" });
		} finally {
			harness.cleanup();
		}
	});

	it("preserves a promoted search tool when the same extension owns it after reload", async () => {
		const owner = "/extensions/owner-a.ts";
		const initial = await extensionResult(owner, (pi) => pi.registerTool(searchTool("remembered_search")));
		const loader = mutableResourceLoader(initial, () =>
			extensionResult(owner, (pi) => pi.registerTool(searchTool("remembered_search"))),
		);
		const harness = await createHarness({ resourceLoader: loader });
		try {
			promote(harness.session, "remembered_search");
			await harness.session.reload();
			expect(harness.session.getActiveToolNames()).toContain("remembered_search");
		} finally {
			harness.cleanup();
		}
	});

	it("does not preserve a promoted search tool when a different extension takes over its name", async () => {
		const initial = await extensionResult("/extensions/owner-a.ts", (pi) =>
			pi.registerTool(searchTool("owner_changed_search")),
		);
		const loader = mutableResourceLoader(initial, () =>
			extensionResult("/extensions/owner-b.ts", (pi) => pi.registerTool(searchTool("owner_changed_search"))),
		);
		const harness = await createHarness({ resourceLoader: loader });
		try {
			promote(harness.session, "owner_changed_search");
			await harness.session.reload();
			expect(harness.session.getAllTools().map(({ name }) => name)).toContain("owner_changed_search");
			expect(harness.session.getActiveToolNames()).not.toContain("owner_changed_search");
		} finally {
			harness.cleanup();
		}
	});

	it("drops a tool no longer registered by an extension that remains loaded", async () => {
		const owner = "/extensions/still-loaded.ts";
		const initial = await extensionResult(owner, (pi) => pi.registerTool(searchTool("removed_registration")));
		const loader = mutableResourceLoader(initial, () => extensionResult(owner, () => {}));
		const harness = await createHarness({ resourceLoader: loader });
		try {
			promote(harness.session, "removed_registration");
			await harness.session.reload();
			expect(harness.session.getAllTools().map(({ name }) => name)).not.toContain("removed_registration");
			expect(harness.session.getActiveToolNames()).not.toContain("removed_registration");
			await expect(
				harness.session.executeTool("removed_registration", {}, { activateInactiveTool: true }),
			).rejects.toMatchObject({ code: "unknown_tool" });
		} finally {
			harness.cleanup();
		}
	});

	it("keeps a newly registered search tool inactive during reload", async () => {
		const owner = "/extensions/growing.ts";
		const initial = await extensionResult(owner, () => {});
		const loader = mutableResourceLoader(initial, () =>
			extensionResult(owner, (pi) => pi.registerTool(searchTool("new_during_reload"))),
		);
		const harness = await createHarness({ resourceLoader: loader });
		try {
			await harness.session.reload();
			expect(harness.session.getAllTools().map(({ name }) => name)).toContain("new_during_reload");
			expect(harness.session.getActiveToolNames()).not.toContain("new_during_reload");
		} finally {
			harness.cleanup();
		}
	});
});
