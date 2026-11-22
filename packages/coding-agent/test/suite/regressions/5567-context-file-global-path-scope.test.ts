import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextFile } from "../../../src/core/context-files.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

// issue #5567 review: `contextFiles.globalPath` names the user's own global instructions, so only
// the user's settings may set it. A trusted project's `.senpi/settings.json` must not redirect it
// (it would otherwise load any file as user-scope instructions), through the real settings and
// resource-loader wiring.
const tempDirs: string[] = [];

function workspace(): { cwd: string; agentDir: string; elsewhere: string } {
	const root = mkdtempSync(join(tmpdir(), "senpi-5567-scope-"));
	tempDirs.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const elsewhereDir = join(root, "elsewhere");
	for (const dir of [join(cwd, ".senpi"), agentDir, elsewhereDir]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(agentDir, "AGENTS.md"), "agent dir instructions");
	const elsewhere = join(elsewhereDir, "rules.md");
	writeFileSync(elsewhere, "redirected instructions");
	return { cwd, agentDir, elsewhere };
}

function writeSettings(path: string, globalPath: string): void {
	writeFileSync(path, JSON.stringify({ contextFiles: { globalPath } }));
}

async function loadAgentsFiles(cwd: string, agentDir: string): Promise<ContextFile[]> {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.create(cwd, agentDir),
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
	});
	await loader.reload();
	return loader.getAgentsFiles().agentsFiles;
}

describe("issue #5567: contextFiles.globalPath is honored from user settings only", () => {
	afterEach(() => {
		while (tempDirs.length > 0) rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
	});

	it("ignores contextFiles.globalPath set in a project's .senpi/settings.json", async () => {
		const { cwd, agentDir, elsewhere } = workspace();
		writeSettings(join(cwd, ".senpi", "settings.json"), elsewhere);

		const files = await loadAgentsFiles(cwd, agentDir);

		expect(files.find((file) => file.path === elsewhere)).toBeUndefined();
		expect(files.find((file) => file.path === join(agentDir, "AGENTS.md"))).toMatchObject({
			content: "agent dir instructions",
			scope: "user",
		});
	});

	it("honors contextFiles.globalPath from the user's global settings", async () => {
		const { cwd, agentDir, elsewhere } = workspace();
		writeSettings(join(agentDir, "settings.json"), elsewhere);

		const files = await loadAgentsFiles(cwd, agentDir);

		expect(files.find((file) => file.path === elsewhere)).toMatchObject({
			content: "redirected instructions",
			scope: "user",
		});
		expect(files.find((file) => file.path === join(agentDir, "AGENTS.md"))).toBeUndefined();
	});
});
