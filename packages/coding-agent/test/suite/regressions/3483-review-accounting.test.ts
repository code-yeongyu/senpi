import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliPromptSizeInventory } from "../../../src/cli/prompt-size-inventory.ts";
import promptPreset from "../../../src/core/extensions/builtin/prompt-preset/index.ts";
import * as presets from "../../../src/core/extensions/builtin/prompt-preset/presets.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { promptSizeExtensionNames } from "../../../src/core/prompt-size-extension-names.ts";
import { PromptSizeAccounting } from "../../../src/core/prompt-size-report.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";
import { realisticOptions } from "./3483-print-prompt-sizes-fixtures.ts";

const fixedFacts = vi.hoisted(() => ({
	osLine: "darwin",
	kernel: "Darwin 25.6.0",
	arch: "arm64",
	cpu: "Apple M4 Pro (14 cores)",
	gpu: "Apple M4 Pro",
	terminal: "xterm-256color",
}));
vi.mock("../../../src/core/dynamic-prompt/workstation.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/core/dynamic-prompt/workstation.ts")>();
	return {
		...actual,
		buildWorkstationSection: (options: Parameters<typeof actual.buildWorkstationSection>[0]) =>
			actual.buildWorkstationSection({ ...options, facts: fixedFacts }),
	};
});

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
});

describe("review accounting regressions (#3483)", () => {
	it("uses package names and disambiguates only colliding identities", async () => {
		// Given: two copies of one named package and an unrelated named package.
		const harness = await createHarness();
		harnesses.push(harness);
		const paths = ["one", "two", "three"].map((directory, index) => {
			const root = join(harness.tempDir, directory);
			mkdirSync(root);
			writeFileSync(
				join(root, "package.json"),
				JSON.stringify({ name: index < 2 ? "@fixture/shared" : "@fixture/unique" }),
			);
			const path = join(root, "index.ts");
			writeFileSync(path, "export {};");
			return path;
		});
		// When
		const names = [...promptSizeExtensionNames(paths, cliPromptSizeInventory.packageNameOf).values()];
		// Then
		expect(new Set(names).size).toBe(paths.length);
		expect(names.slice(0, 2).every((name) => /^@fixture\/shared:[0-9a-f]{8}$/.test(name))).toBe(true);
		expect(names[2]).toBe("@fixture/unique");
	});

	it("does not compute a report for ordinary prewarm builds", async () => {
		// Given
		const report = vi.spyOn(PromptSizeAccounting.prototype, "report");
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		// When
		const result = await harness.getExtensionRunner().createContext().getPromptCachePrefixRequest?.();
		// Then
		if (result?.status !== "ready") throw new Error("Missing prefix");
		expect(result.request.sizeReport).toBeUndefined();
		expect(report).not.toHaveBeenCalled();
	});

	it("reports only the parts actually composed by the selected preset", async () => {
		// Given: observe the real resolver's return, without replacing its implementation.
		const resolved = vi.spyOn(presets, "resolvePreset");
		const extensionsResult = await createTestExtensionsResult([promptPreset]);
		const resourceLoader = {
			...createTestResourceLoader({ extensionsResult }),
			getAgentsFiles: () => ({ agentsFiles: realisticOptions.contextFiles }),
			getSkills: () => ({ skills: realisticOptions.skills, diagnostics: [] }),
		};
		const harness = await createHarness({
			models: [{ id: "claude-opus-4-8" }],
			resourceLoader,
			evalOnlyToolNames: ["bash"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		// When
		const result = await harness.getExtensionRunner().createContext().getPromptCachePrefixRequest?.({
			sizesOnly: true,
		});
		// Then: expected bytes come from this composition's preset parts, never fixed counts.
		if (result?.status !== "ready" || !result.request.sizeReport) throw new Error("Missing report");
		const resolution = resolved.mock.results.at(-1);
		if (resolution?.type !== "return") throw new Error("Preset resolver did not return");
		const preset = resolution.value;
		expect(preset?.parts).toBeDefined();
		if (!preset?.parts) throw new Error("Missing composed preset parts");
		expect(result.request.context.systemPrompt).toBe(preset.parts.map((part) => part.text).join(""));
		const report = result.request.sizeReport;
		expect(report.sections.some((part) => part.name === "session_policy")).toBe(false);
		expect(report.sections.some((part) => part.source === "dynamic-prompt")).toBe(false);
		expect(
			report.sections
				.find((part) => part.name === "project_context")
				?.files?.map((part) => part.source)
				.sort(),
		).toEqual(realisticOptions.contextFiles.map((file) => file.path).sort());
		for (const name of new Set(preset.parts.map((part) => part.name))) {
			expect(report.sections.find((part) => part.name === name)).toMatchObject({
				source: `prompt-preset:${preset.name}`,
				bytes: preset.parts
					.filter((part) => part.name === name)
					.reduce((sum, part) => sum + Buffer.byteLength(part.text), 0),
			});
		}
		expect(report.total.bytes).toBe(
			Buffer.byteLength(result.request.context.systemPrompt ?? "") +
				Buffer.byteLength(JSON.stringify(result.request.context.tools ?? [])),
		);
	});

	it("keeps preset bytes captured from main before the review fold", () => {
		// Given: main 89ecd50ca0 on the fixed facts above, refreshed for #4043's punctuation rewrite.
		const expected = "a526db89da39f3aff8c617319aeb012f0d20f4d761fa3dbcbcc288db09ac2390";
		// When
		const { prompt } = presets.buildPreset("claude-opus-4-8", realisticOptions);
		// Then: a byte-identity golden, not a size assertion.
		expect(createHash("sha256").update(prompt).digest("hex")).toBe(expected);
	});

	it("attributes directory entrypoints to distinct extension names", async () => {
		// Given
		const harness = await createHarness({
			extensionFactories: ["alpha", "beta"].map((name) => ({
				path: `/fixture/${name}/index.ts`,
				factory: (pi: ExtensionAPI) => {
					pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n${name}` }), {
						previewSafe: true,
					});
				},
			})),
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		// When
		const result = await harness.getExtensionRunner().createContext().getPromptCachePrefixRequest?.({
			sizesOnly: true,
		});
		// Then
		if (result?.status !== "ready") throw new Error("Missing prefix");
		expect(result.request.sizeReport?.sections.filter((part) => part.name.startsWith("extension:"))).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "extension:alpha", bytes: Buffer.byteLength("\nalpha") }),
				expect.objectContaining({ name: "extension:beta", bytes: Buffer.byteLength("\nbeta") }),
			]),
		);
	});
});
