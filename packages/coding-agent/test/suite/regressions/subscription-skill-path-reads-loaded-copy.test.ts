import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../src/config.ts";
import { buildAnthropicSubscriptionQueryOptions } from "../../../src/core/extensions/builtin/anthropic-subscription/options.ts";
import { formatSkillsForPrompt, type Skill } from "../../../src/core/skills.ts";

// Regression for code-yeongyu/senpi#6089: the subscription lane renders skill paths in Claude's form, and that rewrite
// must never point the model at a different copy of the skill. A stale ~/.claude/skills farm (or a missing entry)
// resolves elsewhere; the rendered path then has to stay the one the running version loaded.
const temporaryDirectories: string[] = [];
const createdSkillDirectories: string[] = [];

afterEach(() => {
	for (const directory of createdSkillDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const model: Model<Api> = {
	id: "claude-sonnet-4-6",
	name: "claude-sonnet-4-6",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function temp(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function skill(root: string, name: string, description = "Use when the user asks to deploy."): Skill {
	return {
		name,
		description,
		filePath: `${root}/${name}/SKILL.md`,
		baseDir: `${root}/${name}`,
		sourceInfo: { path: `${root}/${name}/SKILL.md`, source: "local", scope: "user", origin: "top-level" },
		disableModelInvocation: false,
		requiresArguments: false,
	} as Skill;
}

function loadSkill(root: string, name: string): Skill {
	const directory = join(root, name);
	createdSkillDirectories.push(directory);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "SKILL.md"), `# ${name}\n`);
	return skill(root, name);
}

function claudeRoots(skills: Skill[], cwd: string, home: string): string[] {
	const previous = process.env.HOME;
	process.env.HOME = home;
	try {
		const options = buildAnthropicSubscriptionQueryOptions({
			model,
			cwd,
			context: { messages: [], systemPrompt: `before${formatSkillsForPrompt(skills)}\nafter` },
			providerSettings: { systemPromptMode: "preset-append" },
		});
		const prompt = options.systemPrompt;
		if (typeof prompt !== "object" || prompt === null || !("append" in prompt)) throw new Error("no preset append");
		const append = String(prompt.append);
		const table = append.slice(append.indexOf("<skill_roots>"), append.indexOf("</skill_roots>"));
		return [...table.matchAll(/<(r\d+)>([^<]+)<\/\1>/g)].map((match) => `${match[1]}=${match[2]}`);
	} finally {
		process.env.HOME = previous;
	}
}

describe("senpi#6089: a rendered skill path always names the copy the runtime loaded", () => {
	it("keeps the loaded absolute path when the Claude-form path resolves to a different copy", () => {
		const home = temp("senpi-6089-home-");
		const cwd = temp("senpi-6089-cwd-");
		const loaded = loadSkill(join(getAgentDir(), "skills"), "ultrawork");
		const staleRoot = temp("senpi-6089-stale-");
		loadSkill(staleRoot, "ultrawork");
		mkdirSync(join(home, ".claude", "skills"), { recursive: true });
		symlinkSync(join(staleRoot, "ultrawork"), join(home, ".claude", "skills", "ultrawork"));

		expect(claudeRoots([loaded], cwd, home)).toEqual([`r0=${join(getAgentDir(), "skills")}`]);
	});

	it("keeps the loaded absolute path when the Claude-form path does not exist", () => {
		const home = temp("senpi-6089-home-");
		const cwd = temp("senpi-6089-cwd-");
		const loaded = loadSkill(join(getAgentDir(), "skills"), "ulw-loop");

		expect(claudeRoots([loaded], cwd, home)).toEqual([`r0=${join(getAgentDir(), "skills")}`]);
	});

	it("uses the Claude-form root when it resolves to the same directory", () => {
		const home = temp("senpi-6089-home-");
		const cwd = temp("senpi-6089-cwd-");
		const skillsRoot = join(getAgentDir(), "skills");
		const loaded = loadSkill(skillsRoot, "programming");
		mkdirSync(join(home, ".claude"), { recursive: true });
		symlinkSync(skillsRoot, join(home, ".claude", "skills"));

		expect(claudeRoots([loaded], cwd, home)).toEqual(["r0=~/.claude/skills"]);
	});

	it("uses the project Claude-form root only when it resolves to the same directory", () => {
		const home = temp("senpi-6089-home-");
		const cwd = temp("senpi-6089-cwd-");
		const projectSkills = join(cwd, CONFIG_DIR_NAME, "skills");
		const loaded = loadSkill(projectSkills, "rules");

		expect(claudeRoots([loaded], cwd, home)).toEqual([`r0=${projectSkills}`]);

		mkdirSync(join(cwd, ".claude"), { recursive: true });
		symlinkSync(projectSkills, join(cwd, ".claude", "skills"));
		expect(claudeRoots([loaded], cwd, home)).toEqual(["r0=.claude/skills"]);
	});
});
