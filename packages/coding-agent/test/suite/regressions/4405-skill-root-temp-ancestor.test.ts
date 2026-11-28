import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSkillReadPath } from "../../../src/core/tools/renderers/skill-read-path.ts";

// senpi#4405: the skill-root walk must not adopt a SKILL.md that sits above the OS temp root when the
// read file lives inside the temp tree; it stops at the temp root as it already stopped at the home.
describe("getSkillReadPath never adopts an ancestor of the OS temp root (senpi#4405)", () => {
	const created: string[] = [];
	afterEach(() => {
		for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("returns undefined for a temp-tree file when a stray SKILL.md sits above the temp root", () => {
		const strayRoot = mkdtempSync(join(tmpdir(), "senpi-4405-stray-"));
		created.push(strayRoot);
		writeFileSync(join(strayRoot, "SKILL.md"), "# stray\n");
		const tempRoot = join(strayRoot, "job-tmp");
		const work = join(tempRoot, "work");
		mkdirSync(work, { recursive: true });
		const file = join(work, "sample.ts");
		writeFileSync(file, "export const answer = 42;\n");

		const previousTemp = process.env.TMPDIR;
		process.env.TMPDIR = tempRoot;
		try {
			expect(getSkillReadPath(file, process.cwd())).toBeUndefined();
		} finally {
			if (previousTemp === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previousTemp;
		}
	});

	it("still labels a file inside a genuine skill directory under the temp root", () => {
		const tempTree = mkdtempSync(join(tmpdir(), "senpi-4405-skill-"));
		created.push(tempTree);
		const skillRoot = join(tempTree, "my-skill");
		mkdirSync(skillRoot);
		writeFileSync(join(skillRoot, "SKILL.md"), "# real skill\n");
		const file = join(skillRoot, "guide.md");
		writeFileSync(file, "content\n");

		expect(getSkillReadPath(file, process.cwd())).toBe("my-skill/guide.md");
	});
});
