import { describe, expect, it } from "vitest";
import { formatSkillsForPrompt, type Skill } from "../../../src/core/skills.ts";
import { isLargeSkillCatalog } from "../../../src/core/skills-prompt.ts";

// Regression for code-yeongyu/senpi#4449: a large skill catalog is one line per skill, and every listed skill's
// file still resolves from its line plus the roots table.
const DESCRIPTION =
	"Runs the release train end to end across the packages, the changelog audit, the tag, the publish workflow and the binary builds. Use when the user says release, cut a release, or hotfix, and also when a publish failed and needs a retry from the existing tag without re-running the script.";

function skill(root: string, name: string, file = `${name}/SKILL.md`): Skill {
	return {
		name,
		description: DESCRIPTION,
		filePath: `${root}/${file}`,
		baseDir: `${root}/${file.split("/").slice(0, -1).join("/")}`,
		sourceInfo: { path: `${root}/${file}`, source: "local", scope: "user", origin: "top-level" },
		disableModelInvocation: false,
		requiresArguments: false,
	} as Skill;
}

function resolveLine(prompt: string, line: string): string {
	const match = line.match(/^- ([^ ]+) \[([^\]]+)\]/);
	if (!match) throw new Error(`not a catalog line: ${line}`);
	const [, name, location] = match;
	const [alias, ...rest] = location.split("/");
	const root = prompt.match(new RegExp(`<${alias}>([^<]+)</${alias}>`))?.[1];
	return rest.length === 0 ? `${root}/${name}/SKILL.md` : `${root}/${rest.join("/")}`;
}

describe("regression senpi#4449: a large skill catalog is listed one line per skill", () => {
	const skills = [
		...Array.from({ length: 96 }, (_, index) => skill("/home/u/.agents/skills", `skill-${index}`)),
		skill("/opt/runtime/dist", "bundled-guide", "bundle/SKILL-3R5ZD4J5.md"),
		skill("/opt/plugin/skills", "plugin-skill"),
	];

	it("treats 98 skills with ~300-character descriptions as large", () => {
		expect(skills.length).toBeLessThanOrEqual(100);
		expect(isLargeSkillCatalog(skills)).toBe(true);
	});

	it("renders name, shortest resolvable location and a short when-to-use line", () => {
		const prompt = formatSkillsForPrompt(skills);
		const lines = prompt.split("\n").filter((line) => line.startsWith("- "));

		expect(lines).toHaveLength(skills.length);
		expect(prompt).not.toContain("<description>");
		expect(prompt).toContain("</available_skills>");
		for (const line of lines) expect(line.slice(line.indexOf("]: ") + 3).length).toBeLessThanOrEqual(160);
		expect(lines[0]).toMatch(/^- skill-0 \[r0\]: Use when the user says release, cut a release, or hotfix/);
		for (const [index, line] of lines.entries()) expect(resolveLine(prompt, line)).toBe(skills[index]?.filePath);
	});

	// The when-to-use clause is what the model selects a skill on, so a cut keeps it whole (or its start, when the
	// clause alone is longer than the line) instead of the leading what-it-does text.
	const LEAD =
		"Operates the deployment toolchain across every environment, including staging rollouts, canary promotion, rollback drills, secret rotation and the post-deploy probes.";
	const shapes: ReadonlyArray<{
		readonly shape: string;
		readonly description: string;
		readonly clause: string;
		readonly startsWith?: string;
	}> = [
		{
			shape: "what it does, then Use when",
			description: `${LEAD} Use when the user asks to deploy or roll back a service.`,
			clause: "Use when the user asks to deploy or roll back a service.",
			// A short trigger leaves room, which goes to the leading what-it-does text.
			startsWith: "Operates the deployment toolchain",
		},
		{
			shape: "Use for after a long lead",
			description: `${LEAD} ${LEAD} Use for any canary or rollback question.`,
			clause: "Use for any canary or rollback question.",
		},
		{
			shape: "Use this whenever",
			description: `${LEAD} Use this whenever someone says /deploy or ship it.`,
			clause: "Use this whenever someone says /deploy or ship it.",
		},
		{
			shape: "MUST USE when, first",
			description: `MUST USE when the user mentions a deploy. ${LEAD} ${LEAD}`,
			clause: "MUST USE when the user mentions a deploy.",
		},
		{
			shape: "USE ONLY WHEN",
			description: `${LEAD} USE ONLY WHEN YOU ARE THE DEPLOY HARNESS. ${LEAD}`,
			clause: "USE ONLY WHEN YOU ARE THE DEPLOY HARNESS.",
		},
		{
			shape: "This skill should be used when",
			description: `${LEAD} This skill should be used when a deploy fails its probe.`,
			clause: "This skill should be used when a deploy fails its probe.",
		},
		{
			shape: "Triggers: list",
			description: `${LEAD} Triggers: 'deploy', 'rollback', 'ship it'.`,
			clause: "Triggers: 'deploy', 'rollback', 'ship it'.",
		},
		{
			shape: "Korean triggers",
			description: `${LEAD} Korean triggers: 배포해줘, 롤백, 카나리 올려.`,
			clause: "Korean triggers: 배포해줘, 롤백, 카나리 올려.",
		},
		{
			shape: "Triggers - Korean list",
			description: `${LEAD} Triggers - 배포, 롤백, 카나리, 프로브 실패.`,
			clause: "Triggers - 배포, 롤백, 카나리, 프로브 실패.",
		},
		{
			shape: "Use when on a later line",
			description: `${LEAD}\n${LEAD}\nUse when a rollout is stuck.`,
			clause: "Use when a rollout is stuck.",
		},
		{
			shape: "clause longer than the line keeps its start",
			description: `${LEAD} MUST USE when the user asks to deploy, promote a canary, roll back, rotate a secret, rerun a probe, drain a region, pin a version, or freeze every rollout across all environments.`,
			clause: "MUST USE when the user asks to deploy, promote a canary, roll back, rotate a secret,",
		},
	];

	it.each(shapes)("keeps the when-to-use clause: $shape", ({ description, clause, startsWith }) => {
		const catalog = [
			...Array.from({ length: 101 }, (_, index) => skill("/home/u/.agents/skills", `skill-${index}`)),
			{ ...skill("/home/u/.agents/skills", "deploy"), description },
		];
		const line = formatSkillsForPrompt(catalog)
			.split("\n")
			.find((entry) => entry.startsWith("- deploy "));
		const text = (line?.slice(line.indexOf("]: ") + 3) ?? "").replaceAll("&apos;", "'");

		expect(text.length).toBeLessThanOrEqual(160);
		expect(text).toContain(clause);
		if (startsWith !== undefined) expect(text.slice(0, startsWith.length)).toBe(startsWith);
	});
});
