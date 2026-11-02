import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

function tool(name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name,
		label: `Label for ${name}`,
		description: `Description for ${name}`,
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
		...overrides,
	};
}

describe("tool search definition metadata", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("projects normalized metadata and the human-readable label from getAllTools", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "senpi-tool-metadata-"));
		tempDirs.push(cwd);
		const agentDir = join(cwd, "agent");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		let api: ExtensionAPI | undefined;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.registerTool(tool("default_tool"));
					pi.registerTool(
						tool("search_tool", {
							label: "Searchable Human Label",
							exposure: "search",
							searchText: "supplemental capability text",
							searchKeywords: ["synonym", "domain-term"],
							searchGroup: "test-group",
							allowLazyActivation: false,
						}),
					);
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});

		try {
			expect(session.getAllTools().find(({ name }) => name === "default_tool")).toMatchObject({
				label: "Label for default_tool",
				exposure: "direct",
				searchKeywords: [],
				allowLazyActivation: true,
			});
			expect(session.getAllTools().find(({ name }) => name === "search_tool")).toMatchObject({
				label: "Searchable Human Label",
				exposure: "search",
				searchText: "supplemental capability text",
				searchKeywords: ["synonym", "domain-term"],
				searchGroup: "test-group",
				allowLazyActivation: false,
			});

			api?.registerTool(
				tool("search_tool", {
					label: "Re-registered Label",
					exposure: "search",
					searchKeywords: ["fresh"],
				}),
			);
			expect(session.getAllTools().find(({ name }) => name === "search_tool")).toMatchObject({
				label: "Re-registered Label",
				exposure: "search",
				searchKeywords: ["fresh"],
				allowLazyActivation: true,
			});
		} finally {
			session.dispose();
		}
	});

	it("ignores searchText when projecting a direct-exposure tool", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "senpi-tool-direct-search-text-"));
		tempDirs.push(cwd);
		const agentDir = join(cwd, "agent");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool(
						tool("direct_tool", {
							exposure: "direct",
							searchText: "must not be projected for direct tools",
						}),
					);
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});

		try {
			expect(session.getAllTools().find(({ name }) => name === "direct_tool")?.searchText).toBeUndefined();
		} finally {
			session.dispose();
		}
	});

	it("rejects the reserved tool_search name from non-builtin extensions", async () => {
		await expect(
			loadExtensionFromFactory(
				(pi) => pi.registerTool(tool("tool_search")),
				process.cwd(),
				createEventBus(),
				createExtensionRuntime(),
				"<inline:reserved-name-test>",
			),
		).rejects.toThrow(/tool_search.*reserved.*builtin/i);
	});

	it("allows the builtin extension to register tool_search", async () => {
		const extension = await loadExtensionFromFactory(
			(pi) => pi.registerTool(tool("tool_search")),
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<builtin:tool-search-test>",
		);

		expect(extension.tools.get("tool_search")?.definition.name).toBe("tool_search");
	});
});
