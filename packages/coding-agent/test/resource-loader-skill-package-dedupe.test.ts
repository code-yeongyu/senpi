import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("DefaultResourceLoader skill dedupe by package identity", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rl-skill-dedupe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		originalHome = process.env.HOME;
		process.env.HOME = tempDir;
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSkillPackage(root: string, packageName: string, skillName: string): string {
		const skillDir = join(root, "skills", skillName);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: packageName, pi: { skills: ["./skills"] } }));
		const skillFile = join(skillDir, "SKILL.md");
		writeFileSync(skillFile, `---\nname: ${skillName}\ndescription: ${skillName} from ${root}\n---\n${root}\n`);
		return skillFile;
	}

	function collisionLosers(loader: DefaultResourceLoader): string[] {
		return loader
			.getSkills()
			.diagnostics.filter((diagnostic) => diagnostic.type === "collision")
			.flatMap((diagnostic) => (diagnostic.collision ? [diagnostic.collision.loserPath] : []));
	}

	function skillFiles(loader: DefaultResourceLoader, skillName: string): string[] {
		return loader
			.getSkills()
			.skills.filter((skill) => skill.name === skillName)
			.map((skill) => skill.filePath);
	}

	it("loads skills once when a second copy of the same package is registered in settings", async () => {
		// given: one package as the CLI extension (global install) and again as a settings package (worktree checkout)
		const cliCopy = join(tempDir, "global-copy");
		const settingsCopy = join(tempDir, "worktree-copy");
		const cliSkill = writeSkillPackage(cliCopy, "same-skill-package", "shared-skill");
		writeSkillPackage(settingsCopy, "same-skill-package", "shared-skill");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			additionalExtensionPaths: [cliCopy],
			settingsManager: SettingsManager.inMemory({
				disabledBuiltinExtensions: ["codemode"],
				packages: [settingsCopy],
			}),
		});

		// when
		await loader.reload();

		// then
		expect(collisionLosers(loader)).toEqual([]);
		expect(skillFiles(loader, "shared-skill")).toEqual([cliSkill]);
	});

	it("still reports a collision when distinct packages ship the same skill name", async () => {
		// given
		const firstPackage = join(tempDir, "first-package");
		const secondPackage = join(tempDir, "second-package");
		const firstSkill = writeSkillPackage(firstPackage, "first-skill-package", "shared-skill");
		const secondSkill = writeSkillPackage(secondPackage, "second-skill-package", "shared-skill");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			additionalExtensionPaths: [firstPackage, secondPackage],
			settingsManager: SettingsManager.inMemory({ disabledBuiltinExtensions: ["codemode"] }),
		});

		// when
		await loader.reload();

		// then
		expect(collisionLosers(loader)).toEqual([secondSkill]);
		expect(skillFiles(loader, "shared-skill")).toEqual([firstSkill]);
	});
});
