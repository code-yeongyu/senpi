import { Type } from "typebox";
import { describe, expect, it } from "vitest";
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
