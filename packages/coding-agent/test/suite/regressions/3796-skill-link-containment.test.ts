// #3796: root selection must retain authority through expansion and declaration caching.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseSkillMcpDeclarations } from "../../../src/core/extensions/builtin/mcp/skills.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "senpi-3796-links-"));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	mkdirSync(join(cwd, ".git"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	vi.stubEnv("HOME", join(root, "home"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function markdown(path: string, name: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `---\nname: ${name}\ndescription: synthetic skill\n---\nsynthetic body\n`);
}

async function load(skills?: string[]) {
	if (skills) {
		mkdirSync(join(cwd, ".senpi"), { recursive: true });
		writeFileSync(join(cwd, ".senpi", "settings.json"), JSON.stringify({ skills }));
	}
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	await loader.reload();
	return loader;
}

it.each(["folder", "file", "nested"] as const)(
	"blocks a project %s escape at the real resource loader",
	async (kind) => {
		const outside = join(root, "outside");
		markdown(join(outside, "SKILL.md"), "escape");
		const selected = join(cwd, ".senpi", "skills");
		mkdirSync(selected, { recursive: true });
		if (kind === "folder") symlinkSync(outside, join(selected, "escape"));
		if (kind === "file") symlinkSync(join(outside, "SKILL.md"), join(selected, "escape.md"));
		if (kind === "nested") {
			mkdirSync(join(selected, "nested"));
			symlinkSync(outside, join(selected, "nested", "escape"));
		}
		const result = (await load()).getSkills();
		expect(result.skills.map((skill) => skill.name)).not.toContain("escape");
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ category: "skill-link-blocked" }));
	},
);

it("keeps deeper user-root links and project links into their reached folders", async () => {
	const target = join(root, "outside");
	markdown(join(target, "SKILL.md"), "allowed");
	mkdirSync(join(agentDir, "skills", "nested"), { recursive: true });
	symlinkSync(target, join(agentDir, "skills", "nested", "allowed"));
	mkdirSync(join(cwd, ".senpi", "skills"), { recursive: true });
	symlinkSync(target, join(cwd, ".senpi", "skills", "allowed"));
	expect((await load()).getSkills().skills.map((skill) => skill.name)).toContain("allowed");
});

it("allows a selected project root without authorizing its escaping child", async () => {
	const selected = join(root, "selected");
	markdown(join(selected, "ordinary", "SKILL.md"), "selected");
	const other = join(root, "unselected");
	markdown(join(other, "SKILL.md"), "escape");
	symlinkSync(other, join(selected, "escaped"));
	const result = (await load([selected])).getSkills();
	expect(result.skills.map((skill) => skill.name)).toContain("selected");
	expect(result.skills.map((skill) => skill.name)).not.toContain("escape");
	expect(result.diagnostics).toContainEqual(expect.objectContaining({ category: "skill-link-blocked" }));
});

it("keeps an exact user-file grant without granting its outside parent", async () => {
	const outside = join(root, "outside");
	const exact = join(outside, "exact.md");
	markdown(exact, "exact");
	markdown(join(outside, "sibling.md"), "escape");
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: [exact] }));
	const selected = join(cwd, ".senpi", "skills");
	mkdirSync(selected, { recursive: true });
	symlinkSync(exact, join(selected, "exact.md"));
	symlinkSync(join(outside, "sibling.md"), join(selected, "sibling.md"));
	const result = (await load()).getSkills();
	expect(result.skills.map((skill) => skill.name)).toContain("exact");
	expect(result.skills.map((skill) => skill.name)).not.toContain("escape");
});

it("loads a nested same-worktree link", async () => {
	const target = join(cwd, "shared", "nested");
	markdown(join(target, "SKILL.md"), "local");
	const selected = join(cwd, ".senpi", "skills");
	mkdirSync(selected, { recursive: true });
	symlinkSync(target, join(selected, "local"));
	expect((await load()).getSkills().skills.map((skill) => skill.name)).toContain("local");
});

it("rechecks a sidecar link rather than reusing a user declaration cache entry", async () => {
	const skillDir = join(cwd, ".senpi", "skills", "carrier");
	markdown(join(skillDir, "SKILL.md"), "carrier");
	const outside = join(root, "outside.json");
	writeFileSync(outside, JSON.stringify({ escaped: { command: "synthetic" } }));
	symlinkSync(outside, join(skillDir, "mcp.json"));
	const projectSkill = (await load()).getSkills().skills.find((skill) => skill.name === "carrier");
	if (!projectSkill) throw new Error("fixture skill missing");
	const userSkill = { ...projectSkill, provenance: { kind: "user" as const, selectedRoot: skillDir } };
	expect(parseSkillMcpDeclarations([userSkill]).servers.has("escaped")).toBe(true);
	const project = parseSkillMcpDeclarations([projectSkill]);
	expect(project.servers.size).toBe(0);
	expect(project.warnings).toHaveLength(1);
});
