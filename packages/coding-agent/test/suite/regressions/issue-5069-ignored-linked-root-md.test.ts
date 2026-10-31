import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { collectSkillEntries } from "../../../src/core/skill-discovery.ts";
import { loadSkillsFromDir } from "../../../src/core/skills.ts";

let base: string;
let skillsRoot: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "senpi-5069-")));
	skillsRoot = join(base, "skills");
	mkdirSync(skillsRoot);
	mkdirSync(join(base, "elsewhere"));
	writeFileSync(join(base, "elsewhere", "demo.md"), "---\nname: demo\ndescription: demo skill.\n---\nbody\n");
	symlinkSync(join(base, "elsewhere", "demo.md"), join(skillsRoot, "demo.md"));
	writeFileSync(join(skillsRoot, "plain.md"), "---\nname: plain\ndescription: plain skill.\n---\nbody\n");
	writeFileSync(join(skillsRoot, ".gitignore"), "/demo.md\n/plain.md\n");
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

it("#given a git-ignored symlinked root-level skill file #when loading the root #then the linked file loads and a git-ignored real file stays skipped", () => {
	const { skills } = loadSkillsFromDir({ dir: skillsRoot, source: "user" });

	expect(skills.map((skill) => skill.name)).toEqual(["demo"]);
});

it("#given a git-ignored symlinked root-level skill file #when collecting entries #then it is a candidate and the real ignored file is not", () => {
	expect(collectSkillEntries(skillsRoot, "pi")).toEqual([join(skillsRoot, "demo.md")]);
});
