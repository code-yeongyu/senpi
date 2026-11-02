import { vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		realpathSync: Object.assign(vi.fn(actual.realpathSync), { native: vi.fn(actual.realpathSync.native) }),
		readdirSync: vi.fn(actual.readdirSync),
	};
});

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { buildSkillAllowedSet } from "../../../src/core/skill-access.ts";

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-4213-")));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	mkdirSync(join(cwd, ".git"), { recursive: true });
	mkdirSync(agentDir);
	vi.stubEnv("HOME", root);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function skill(path: string, name: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `---\nname: ${name}\ndescription: synthetic skill\n---\nbody\n`);
}

function loader(noSkills = false): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd,
		agentDir,
		noSkills,
		noExtensions: true,
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
	});
}

it("resolves each directory only once within an allowed-set build", () => {
	const source = join(agentDir, "skills");
	skill(join(source, "nested", "SKILL.md"), "nested");
	vi.mocked(realpathSync.native).mockClear();
	const allowed = buildSkillAllowedSet([source, source]);
	expect(allowed.roots).toEqual([source, join(source, "nested")].sort());
	const calls = vi.mocked(realpathSync.native).mock.calls.map(([path]) => String(path));
	expect(calls).toEqual([source, join(source, "nested")]);
});

it.each([50, 200])("loads %i skills with linear filesystem calls despite duplicate root selections", async (count) => {
	const userRoot = join(root, ".agents", "skills");
	const links = join(agentDir, "skills");
	mkdirSync(links);
	for (let index = 0; index < count; index++) {
		const name = `skill-${index}`;
		skill(join(userRoot, name, "SKILL.md"), name);
		symlinkSync(join(userRoot, name), join(links, name), "junction");
	}
	const resources = loader();
	vi.mocked(realpathSync.native).mockClear();
	vi.mocked(readdirSync).mockClear();
	await resources.reload();
	expect(resources.getSkills().skills).toHaveLength(count);
	const realpaths = vi.mocked(realpathSync.native).mock.calls.filter(([path]) => String(path).startsWith(root)).length;
	const reads = vi.mocked(readdirSync).mock.calls.filter(([path]) => String(path).startsWith(root)).length;
	console.log(JSON.stringify({ count, realpaths, reads }));
	expect(realpaths).toBeLessThanOrEqual(20 * count + 100);
	expect(reads).toBeLessThanOrEqual(10 * count + 100);
});

it("does not reuse reached user directories after a link is retargeted between loads", async () => {
	const first = join(root, "first");
	const second = join(root, "second");
	skill(join(first, "SKILL.md"), "first");
	skill(join(second, "SKILL.md"), "second");
	const userLink = join(agentDir, "skills", "selected");
	mkdirSync(dirname(userLink), { recursive: true });
	symlinkSync(first, userLink, "junction");
	const projectLink = join(cwd, ".senpi", "skills", "old-target");
	mkdirSync(dirname(projectLink), { recursive: true });
	symlinkSync(first, projectLink, "junction");
	const resources = loader();
	await resources.reload();
	expect(resources.getSkills().diagnostics.filter((entry) => entry.category === "skill-link-blocked")).toEqual([]);
	unlinkSync(userLink);
	symlinkSync(second, userLink, "junction");
	await resources.reload();
	expect(resources.getSkills().skills.map((entry) => entry.name)).toEqual(["second"]);
	expect(resources.getSkills().diagnostics).toContainEqual(
		expect.objectContaining({ category: "skill-link-blocked", path: join(projectLink, "SKILL.md") }),
	);
});

it("skips the allowed-set walk with no skills and no extension skill paths", async () => {
	skill(join(agentDir, "skills", "unused", "SKILL.md"), "unused");
	const resources = loader(true);
	vi.mocked(readdirSync).mockClear();
	await resources.reload();
	expect(resources.getSkills().skills).toEqual([]);
	// Package discovery may visit this root once; loading must not scan it again for authority.
	const reads = vi.mocked(readdirSync).mock.calls.filter(([path]) => String(path) === join(agentDir, "skills")).length;
	expect(reads).toBeLessThanOrEqual(1);
});
