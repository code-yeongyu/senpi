import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import { createToolSearchExtension, ToolSearchService } from "../../src/core/extensions/builtin/tool-search/index.ts";
import { createToolSearchTool } from "../../src/core/extensions/builtin/tool-search/tool.ts";
import type { ResourceLoader } from "../../src/core/resource-loader.ts";
import { createReadToolDefinition } from "../../src/core/tools/read.ts";
import type { ExtensionAPI, LoadExtensionsResult } from "../../src/index.ts";
import { createHarness } from "../suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

const TOOL_NAMES = ["todo", "read", "tool_search"] as const;
type ToolName = (typeof TOOL_NAMES)[number];
type Replacement = "retained" | "removed" | "new-owner";

async function reloadHarness(selected: ToolName, replacement: Replacement) {
	let replaced = false;
	const deferRegistration = (pi: ExtensionAPI): ExtensionAPI => ({
		...pi,
		registerTool: (definition) => {
			if (replaced && replacement === "removed" && definition.name === selected) return;
			pi.registerTool({ ...definition, exposure: "search" });
		},
	});
	const load = (): Promise<LoadExtensionsResult> => {
		const owner = replaced && replacement === "new-owner" ? "replacement" : "original";
		return createTestExtensionsResult([
			{
				path: `<builtin:${owner}-tool-search>`,
				factory: (pi) => {
					const service = new ToolSearchService(pi);
					const api = deferRegistration(pi);
					createToolSearchExtension(service)(api);
					api.registerTool(createToolSearchTool(service));
				},
			},
			{
				path: `/extensions/${owner}-todo.ts`,
				factory: (pi) => todotoolsExtension(deferRegistration(pi)),
			},
			{
				path: `/extensions/${owner}-read.ts`,
				factory: (pi) => deferRegistration(pi).registerTool(createReadToolDefinition(process.cwd())),
			},
		]);
	};
	let current = await load();
	const resourceLoader: ResourceLoader = {
		...createTestResourceLoader(),
		getExtensions: () => current,
		reload: async () => {
			replaced = true;
			current = await load();
		},
	};
	const harness = await createHarness({ resourceLoader, tools: [] });
	const path = join(harness.tempDir, "reload-input.txt");
	writeFileSync(path, "The replacement generation reads this file.\n");
	const calls = {
		todo: { op: "init", items: ["Verify tools survive the extension reload"] },
		read: { path },
		tool_search: { query: "read file", source: "extension" },
	};
	return { harness, args: calls[selected] };
}

describe("real builtin tools across extension generation replacement", () => {
	// Regression: omo#9365, senpi#2506. Exercise real implementations, not name-only tool doubles.
	it.each(TOOL_NAMES)("executes deferred %s when its extension has reloaded", async (name) => {
		// Given: real builtin implementations exposed through the extension catalog.
		const { harness, args } = await reloadHarness(name, "retained");
		try {
			await harness.session.reload();
			// When: the first call activates the tool through the replacement catalog.
			const result = await harness.session.executeTool(name, args, { activateInactiveTool: true });
			// Then: the caller receives the real operation's output.
			switch (name) {
				case "todo":
					expect(result.details).toMatchObject({
						phases: [
							{ tasks: [{ content: "Verify tools survive the extension reload", status: "in_progress" }] },
						],
					});
					break;
				case "read":
					expect(result.content).toContainEqual({
						type: "text",
						text: "The replacement generation reads this file.\n",
					});
					break;
				case "tool_search":
					expect(result.details).toMatchObject({ matched: expect.arrayContaining(["read"]) });
					break;
				default:
					name satisfies never;
			}
		} finally {
			harness.cleanup();
		}
	});

	it.each(TOOL_NAMES)("reports an unavailable %s when reload removes its registration", async (name) => {
		// Given: a promoted tool that the replacement generation no longer registers.
		const { harness, args } = await reloadHarness(name, "removed");
		try {
			harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), name]);
			await harness.session.reload();
			// When: the caller tries the removed tool, including lazy activation.
			const execution = harness.session.executeTool(name, args, { activateInactiveTool: true });
			// Then: removal is explicit; no retired implementation or API is invoked.
			await expect(execution).rejects.toMatchObject({ code: "unknown_tool", toolName: name });
		} finally {
			harness.cleanup();
		}
	});

	// tool_search re-activates itself whenever its catalog has documents, so only tools whose activation stays
	// explicit can show that a new owner does not inherit the previous owner's active status.
	it.each(["todo", "read"] as const)(
		"requires explicit activation when a new extension takes over %s",
		async (name) => {
			// Given: an active tool name is registered by a different extension after reload.
			const { harness, args } = await reloadHarness(name, "new-owner");
			try {
				harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), name]);
				await harness.session.reload();
				// When: a caller relies on the old owner's activation without opting into a new one.
				const execution = harness.session.executeTool(name, args);
				// Then: the replacement cannot silently inherit the old owner's active status.
				await expect(execution).rejects.toMatchObject({ code: "inactive_tool", toolName: name });
			} finally {
				harness.cleanup();
			}
		},
	);
});
