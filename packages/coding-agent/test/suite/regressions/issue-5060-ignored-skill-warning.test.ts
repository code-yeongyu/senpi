import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

let root: string;
let cwd: string;
let agentDir: string;
let skillsRoot: string;

function writeSkill(dir: string, name: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "SKILL.md");
	writeFileSync(file, `---\nname: ${name}\ndescription: ${name} skill.\n---\nbody\n`);
	return file;
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-5060-warn-")));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	skillsRoot = join(root, ".agents", "skills");
	mkdirSync(join(cwd, ".git"), { recursive: true });
	mkdirSync(agentDir);
	mkdirSync(skillsRoot, { recursive: true });
	vi.stubEnv("HOME", root);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

async function load(): Promise<DefaultResourceLoader> {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
	});
	await loader.reload();
	return loader;
}

it("#given a skill folder hidden by the skills root's .gitignore #when loading #then a skill-ignored warning names its SKILL.md and the ignore files", async () => {
	const hidden = writeSkill(join(skillsRoot, "hidden"), "hidden");
	writeSkill(join(skillsRoot, "kept"), "kept");
	writeFileSync(join(skillsRoot, ".gitignore"), "/hidden\n");

	const { skills, diagnostics } = (await load()).getSkills();

	expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
	const ignored = diagnostics.filter((diagnostic) => diagnostic.category === "skill-ignored");
	expect(ignored).toHaveLength(1);
	expect(ignored[0]).toMatchObject({ type: "warning", path: hidden });
	expect(ignored[0]?.message).toContain(".gitignore");
});

it("#given a git-ignored symlinked skill folder #when loading #then it loads and raises no skill-ignored warning", async () => {
	writeSkill(join(root, "elsewhere", "linked"), "linked");
	symlinkSync(join(root, "elsewhere", "linked"), join(skillsRoot, "linked"), "dir");
	writeFileSync(join(skillsRoot, ".gitignore"), "/linked\n");

	const { skills, diagnostics } = (await load()).getSkills();

	expect(skills.map((skill) => skill.name)).toEqual(["linked"]);
	expect(diagnostics.filter((diagnostic) => diagnostic.category === "skill-ignored")).toEqual([]);
});

it("#given an ignored folder without a SKILL.md #when loading #then no warning is raised", async () => {
	mkdirSync(join(skillsRoot, "build"), { recursive: true });
	writeFileSync(join(skillsRoot, "build", "out.txt"), "x");
	writeSkill(join(skillsRoot, "kept"), "kept");
	writeFileSync(join(skillsRoot, ".gitignore"), "/build\n");

	const { diagnostics } = (await load()).getSkills();

	expect(diagnostics.filter((diagnostic) => diagnostic.category === "skill-ignored")).toEqual([]);
});
