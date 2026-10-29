import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../src/config.ts";
import { buildAnthropicSubscriptionQueryOptions } from "../../../src/core/extensions/builtin/anthropic-subscription/options.ts";
import { formatSkillsForPrompt, type Skill } from "../../../src/core/skills.ts";

// Regression for code-yeongyu/senpi#4518: the Claude subscription lane points skill files at ~/.claude/skills and
// .claude/skills. Since the catalog lists roots in a <skill_roots> table with rN/ aliases, the rewrite has to apply to
// that table, for the XML catalog and the one-line catalog alike.
const temporaryDirectories: string[] = [];

afterEach(() => {
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

function appendFor(systemPrompt: string, cwd: string): string {
	const options = buildAnthropicSubscriptionQueryOptions({
		model,
		cwd,
		context: { messages: [], systemPrompt },
		providerSettings: { systemPromptMode: "preset-append" },
	});
	const prompt = options.systemPrompt;
	if (typeof prompt !== "object" || prompt === null || !("append" in prompt)) throw new Error("no preset append");
	return String(prompt.append);
}

function roots(append: string): string[] {
	const table = append.slice(append.indexOf("<skill_roots>"), append.indexOf("</skill_roots>"));
	return [...table.matchAll(/<(r\d+)>([^<]+)<\/\1>/g)].map((match) => `${match[1]}=${match[2]}`);
}

describe("regression senpi#4518: the subscription lane rewrites skill roots to Claude's skill directories", () => {
	const cases: ReadonlyArray<{ readonly shape: string; readonly count: number }> = [
		{ shape: "XML catalog with a roots table", count: 3 },
		{ shape: "one-line catalog", count: 101 },
	];

	it.each(cases)("$shape: global and project roots rewritten, unrelated roots untouched", ({ count }) => {
		const cwd = mkdtempSync(join(tmpdir(), "senpi-4518-"));
		temporaryDirectories.push(cwd);
		const globalRoot = join(getAgentDir(), "skills");
		const projectRoot = join(cwd, CONFIG_DIR_NAME, "skills");
		const skills = [
			skill(globalRoot, "global-skill"),
			skill(`${globalRoot}/team`, "nested-skill"),
			skill(projectRoot, "project-skill"),
			skill("/opt/plugin/skills", "plugin-skill"),
			skill(`${globalRoot}-extra`, "sibling-skill"),
			...Array.from({ length: Math.max(0, count - 5) }, (_, index) => skill("/opt/plugin/skills", `pad-${index}`)),
		];
		const catalog = formatSkillsForPrompt(skills);
		expect(catalog.includes("<description>")).toBe(count <= 100);

		const append = appendFor(`before${catalog}\nafter`, cwd);

		expect(roots(append)).toEqual([
			"r0=~/.claude/skills",
			"r1=~/.claude/skills/team",
			"r2=.claude/skills",
			"r3=/opt/plugin/skills",
			`r4=${globalRoot}-extra`,
		]);
	});

	it("legacy XML catalog with absolute locations: global and project locations rewritten", () => {
		const cwd = mkdtempSync(join(tmpdir(), "senpi-4518-"));
		temporaryDirectories.push(cwd);
		const globalRoot = join(getAgentDir(), "skills");
		const projectRoot = join(cwd, CONFIG_DIR_NAME, "skills");
		const catalog = [
			"The following skills provide specialized instructions for specific tasks.",
			"<available_skills>",
			`  <skill><name>a</name><location>${globalRoot}/a/SKILL.md</location></skill>`,
			`  <skill><name>b</name><location>${projectRoot}/b/SKILL.md</location></skill>`,
			"  <skill><name>c</name><location>/opt/plugin/skills/c/SKILL.md</location></skill>",
			"</available_skills>",
		].join("\n");

		const locations = [...appendFor(catalog, cwd).matchAll(/<location>([^<]+)<\/location>/g)].map((m) => m[1]);

		expect(locations).toEqual([
			"~/.claude/skills/a/SKILL.md",
			".claude/skills/b/SKILL.md",
			"/opt/plugin/skills/c/SKILL.md",
		]);
	});
});
