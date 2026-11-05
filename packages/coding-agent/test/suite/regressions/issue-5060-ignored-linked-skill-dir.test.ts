import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSkillEntries } from "../../../src/core/skill-discovery.ts";
import { loadSkillsFromDir } from "../../../src/core/skills.ts";

let base: string;
let skillsRoot: string;

function writeSkill(dir: string, name: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill.\n---\nbody\n`);
}

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "senpi-5060-")));
	skillsRoot = join(base, "skills");
	mkdirSync(skillsRoot);
	writeSkill(join(base, "elsewhere", "linked"), "linked");
	symlinkSync(join(base, "elsewhere", "linked"), join(skillsRoot, "linked"), "dir");
	writeSkill(join(skillsRoot, "plain-ignored"), "plain-ignored");
	writeSkill(join(skillsRoot, "kept"), "kept");
	writeFileSync(join(skillsRoot, ".gitignore"), "/linked\n/plain-ignored\n");
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("skills root ignore files and symlinked skill directories (#5060)", () => {
	it("#given a git-ignored symlinked skill dir #when loading the root #then the linked skill loads and a git-ignored real dir stays skipped", () => {
		const { skills } = loadSkillsFromDir({ dir: skillsRoot, source: "user" });

		expect(skills.map((skill) => skill.name).sort()).toEqual(["kept", "linked"]);
	});

	it("#given a git-ignored symlinked skill dir #when collecting entries #then its SKILL.md is a candidate and the real ignored dir is not", () => {
		const entries = collectSkillEntries(skillsRoot, "pi");

		expect(entries.sort()).toEqual([join(skillsRoot, "kept", "SKILL.md"), join(skillsRoot, "linked", "SKILL.md")]);
	});

	it("#given the linked tree ignores its own nested skill #when loading the root #then that nested skill stays skipped", () => {
		const container = join(base, "elsewhere", "bundle");
		writeSkill(join(container, "visible"), "visible");
		writeSkill(join(container, "hidden"), "hidden");
		writeFileSync(join(container, ".gitignore"), "hidden/\n");
		symlinkSync(container, join(skillsRoot, "bundle"), "dir");

		const loaded = loadSkillsFromDir({ dir: skillsRoot, source: "user" }).skills.map((skill) => skill.name);
		const collected = collectSkillEntries(skillsRoot, "pi");

		expect(loaded).toContain("visible");
		expect(loaded).not.toContain("hidden");
		expect(collected).toContain(join(skillsRoot, "bundle", "visible", "SKILL.md"));
		expect(collected).not.toContain(join(skillsRoot, "bundle", "hidden", "SKILL.md"));
	});
});
