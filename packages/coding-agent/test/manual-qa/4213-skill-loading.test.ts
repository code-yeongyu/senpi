import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

it("measures loading 748 skills with 476 duplicate links, including extension discovery", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-4213-bench-")));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const userRoot = join(root, ".agents", "skills");
	const links = join(agentDir, "skills");
	mkdirSync(join(cwd, ".git"), { recursive: true });
	mkdirSync(links, { recursive: true });
	vi.stubEnv("HOME", root);
	try {
		for (let index = 0; index < 748; index++) {
			const name = `skill-${index}`;
			const dir = join(index < 717 ? userRoot : links, name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "SKILL.md"),
				`---\nname: ${name}\ndescription: synthetic benchmark skill\n---\nbody\n`,
			);
			if (index < 476) symlinkSync(dir, join(links, name), "junction");
		}
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
		});
		const start = performance.now();
		await loader.reload();
		const loaded = performance.now();
		loader.extendResources({
			skillPaths: [
				{
					path: join(userRoot, "skill-0", "SKILL.md"),
					metadata: { source: "local", scope: "user", origin: "top-level", baseDir: dirname(userRoot) },
				},
			],
		});
		const extended = performance.now();
		expect(loader.getSkills().skills).toHaveLength(748);
		console.log(
			JSON.stringify({
				skills: 748,
				folders: 717,
				duplicateLinks: 476,
				reloadMs: loaded - start,
				extensionMs: extended - loaded,
				totalMs: extended - start,
			}),
		);
	} finally {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
}, 180000);
