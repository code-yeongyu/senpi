import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { computerPreludeAssets } from "@code-yeongyu/senpi-desktop-prelude";
import { COMPUTER_SKILL_NAME } from "@code-yeongyu/senpi-desktop-tool";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkillsFromDir } from "../../src/core/skills.ts";
import { type ComputerUseHarness, createComputerUseHarness } from "./computer-use-harness.ts";

const open: ComputerUseHarness[] = [];

async function harnessWith(options: Parameters<typeof createComputerUseHarness>[0] = {}): Promise<ComputerUseHarness> {
	const created = await createComputerUseHarness(options);
	open.push(created);
	return created;
}

async function discoveredSkillPaths(computerUse: ComputerUseHarness): Promise<string[]> {
	const result = await computerUse.harness
		.getExtensionRunner()
		.emitResourcesDiscover(computerUse.harness.tempDir, "reload");
	return result.skillPaths.map((entry) => entry.path);
}

afterEach(async () => {
	await Promise.all(open.splice(0).map((created) => created.cleanup()));
});

describe("computer-use skill contribution", () => {
	it("resources_discover exposes computer skill when active", async () => {
		// When
		const computerUse = await harnessWith();

		// Then
		const paths = await discoveredSkillPaths(computerUse);
		expect(paths).toHaveLength(1);
		const loaded = loadSkillsFromDir({ dir: dirname(paths[0] ?? ""), source: "extension" });
		expect(loaded.skills.map((skill) => skill.name)).toEqual([COMPUTER_SKILL_NAME]);
		expect(loaded.diagnostics).toEqual([]);
		const text = readFileSync(paths[0] ?? "", "utf8");
		expect(text).toContain(computerPreludeAssets.documentation.trim());
		expect(text).toContain(computerPreludeAssets.safety.trim());
	});

	it("contributes nothing on an unsupported host", async () => {
		// When
		const computerUse = await harnessWith({ platform: "freebsd" });

		// Then
		expect(await discoveredSkillPaths(computerUse)).toEqual([]);
	});

	it("contributes nothing when computer.enabled is false", async () => {
		// When
		const computerUse = await harnessWith({ computer: { enabled: false } });

		// Then
		expect(await discoveredSkillPaths(computerUse)).toEqual([]);
	});
});
