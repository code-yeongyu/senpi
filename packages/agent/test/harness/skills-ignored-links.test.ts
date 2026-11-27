import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { loadSkills } from "../../src/harness/skills.ts";
import { createTempDir } from "./session-test-utils.ts";

const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill.\n---\nbody\n`;

it("#given a skills root whose .gitignore lists linked and real entries #when loading #then linked entries load and the real ignored folder is skipped (senpi#5069)", async () => {
	const root = createTempDir();
	await mkdir(join(root, "elsewhere", "linked"), { recursive: true });
	await writeFile(join(root, "elsewhere", "linked", "SKILL.md"), skill("linked"));
	await writeFile(join(root, "elsewhere", "demo.md"), skill("demo"));
	await mkdir(join(root, "skills", "hidden"), { recursive: true });
	await writeFile(join(root, "skills", "hidden", "SKILL.md"), skill("hidden"));
	await symlink(join(root, "elsewhere", "linked"), join(root, "skills", "linked"));
	await symlink(join(root, "elsewhere", "demo.md"), join(root, "skills", "demo.md"));
	await writeFile(join(root, "skills", ".gitignore"), "/linked\n/demo.md\n/hidden\n");
	const env = new NodeExecutionEnv({ cwd: root });

	const { skills } = await loadSkills(env, "skills", BACKGROUND_CONTEXT);

	expect(skills.map((entry) => entry.name).sort()).toEqual(["demo", "linked"]);
});
