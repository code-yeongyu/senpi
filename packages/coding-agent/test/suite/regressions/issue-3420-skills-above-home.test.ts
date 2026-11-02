/**
 * senpi#3420 review: the trust check and the skill loader must agree on which `.agents/skills`
 * folders are project ones. A folder above the user's home is never a project, so a skill there is
 * never loaded as a project skill, trusted project or not.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "senpi-3420-skills-"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function skill(dir: string, name: string): void {
	mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: probe ${name}\n---\nbody\n`);
}

it("never loads a skill from .agents/skills above home as a project skill", async () => {
	const home = join(root, "home", "user");
	const cwd = join(home, "code", "app");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	vi.stubEnv("HOME", home);
	skill(join(root, "home", ".agents", "skills"), "above-home");
	skill(join(home, "code", ".agents", "skills"), "in-project");

	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	await loader.reload();
	const names = loader.getSkills().skills.map((entry) => entry.name);

	expect(names).toContain("in-project");
	expect(names).not.toContain("above-home");
});
