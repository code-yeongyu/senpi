import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { MOVED_PATH_TOOL_CLASSES } from "../../src/core/extensions/builtin/moved-path-guard/tool-classes.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";
import { createMovedLayout, type MovedLayout, runTool } from "./moved-path-guard-fixtures.ts";

/**
 * code-yeongyu/senpi#2898: the guard is only as complete as its tool list. Every tool a FULL load registers (builtins,
 * the bundled codemode `eval`, `tool_search`) must carry a moved-path class, so a new builtin cannot ship unclassified;
 * and a tool from outside that list is never silently allowed to name a moved path (review M3).
 */

describe("moved-path-guard tool classes (#2898)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	async function fullLoad(extensionFactories: Array<(pi: ExtensionAPI) => void> = []): Promise<Harness> {
		const tempDir = mkdtempSync(join(tmpdir(), "senpi-moved-classes-"));
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			settingsManager: SettingsManager.inMemory({}),
			extensionFactories: [
				...extensionFactories,
				(pi) =>
					pi.registerTool({
						name: "zz_search_only",
						label: "search only",
						description: "Registers the tool_search catalog.",
						parameters: Type.Object({}),
						exposure: "search",
						execute: async () => ({ content: [], details: {} }),
					}),
			],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const harness = await createHarness({ resourceLoader: loader });
		cleanups.push(() => {
			harness.cleanup();
			rmSync(tempDir, { recursive: true, force: true });
		});
		await harness.session.bindExtensions({});
		return harness;
	}

	it("classifies every tool of a full load, including eval and tool_search", async () => {
		const harness = await fullLoad();

		const registered = harness.session
			.getAllTools()
			.map((tool) => tool.name)
			.filter((name) => name !== "zz_search_only");
		const unclassified = registered.filter((name) => !Object.hasOwn(MOVED_PATH_TOOL_CLASSES, name));

		expect(registered).toEqual(expect.arrayContaining(["eval", "tool_search", "write", "bash"]));
		expect(unclassified).toEqual([]);
	});

	it("refuses an unclassified tool whose string argument names a moved path", async () => {
		const layout: MovedLayout = createMovedLayout();
		cleanups.push(layout.cleanup);
		const guard = builtinExtensions.find((entry) => entry.id === "moved-path-guard");
		if (!guard) throw new Error("moved-path-guard is not registered");
		let ran = false;
		const harness = await createHarness({
			cwd: layout.home,
			extensionFactories: [
				guard.factory,
				(pi) =>
					pi.registerTool({
						name: "third_party_writer",
						label: "writer",
						description: "Writes a file somewhere.",
						parameters: Type.Object({ options: Type.Object({ target: Type.String() }) }),
						execute: async () => {
							ran = true;
							return { content: [{ type: "text", text: "wrote" }], details: {} };
						},
					}),
			],
			initialActiveToolNames: ["third_party_writer"],
		});
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});

		const result = await runTool(harness, "third_party_writer", {
			options: { target: `${layout.oldWorktree}/out.txt` },
		});

		expect(result.outcome).toBe("blocked");
		expect(result.text).toContain(layout.newWorktree);
		expect(ran).toBe(false);
	});
});
