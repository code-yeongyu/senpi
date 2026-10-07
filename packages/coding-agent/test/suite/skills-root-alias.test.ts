import { describe, expect, it } from "vitest";
import { formatSkillsForPrompt, type Skill } from "../../src/core/skills.ts";

function skill(name: string, root: string): Skill {
	return {
		name,
		description: `${name} description.`,
		filePath: `${root}/${name}/SKILL.md`,
		baseDir: `${root}/${name}`,
	} as Skill;
}

describe("formatSkillsForPrompt root aliases", () => {
	it("declares each skill root once and renders locations relative to it", () => {
		const skills = [
			skill("alpha", "/Users/u/.agents/skills"),
			skill("beta", "/Users/u/.agents/skills"),
			skill("gamma", "/opt/plugin/skills"),
		];

		const result = formatSkillsForPrompt(skills);

		// each root appears once in a roots table
		expect(result).toContain("<skill_roots>");
		expect(result).toContain("<location>r0/alpha/SKILL.md</location>");
		expect(result).toContain("<location>r0/beta/SKILL.md</location>");
		expect(result).toContain("<location>r1/gamma/SKILL.md</location>");
		// the absolute roots are stated exactly once each, in the table
		expect(result.split("/Users/u/.agents/skills").length - 1).toBe(1);
		expect(result.split("/opt/plugin/skills").length - 1).toBe(1);
		// an expansion rule teaches the model to join alias + relative path
		expect(result).toMatch(/expand|resolve|join/i);
	});

	it("keeps the absolute path resolvable for every skill", () => {
		const skills = [skill("alpha", "/Users/u/.agents/skills"), skill("gamma", "/opt/plugin/skills")];

		const result = formatSkillsForPrompt(skills);
		const aliasForRoot: Record<string, string> = {};
		for (const m of result.matchAll(/<(r\d+)>([^<]+)<\/\1>/g)) aliasForRoot[m[1]] = m[2];
		const locations = [...result.matchAll(/<location>(r\d+)\/([^<]+)<\/location>/g)];
		expect(locations).toHaveLength(2);
		const resolved = locations.map(([, alias, rel]) => `${aliasForRoot[alias]}/${rel}`);
		expect(resolved).toContain("/Users/u/.agents/skills/alpha/SKILL.md");
		expect(resolved).toContain("/opt/plugin/skills/gamma/SKILL.md");
	});

	it("renders fewer location characters than absolute paths when roots are long", () => {
		const longRoot = "/Users/yeongyu/.bun/install/global/node_modules/omo-ai/plugin/skills";
		const skills = Array.from({ length: 24 }, (_, i) => skill(`s${i}`, longRoot));
		const result = formatSkillsForPrompt(skills);
		const locationChars = [...result.matchAll(/<location>([^<]+)<\/location>/g)].reduce((n, m) => n + m[1].length, 0);
		const absoluteLocationChars = skills.reduce((n, s) => n + s.filePath.length, 0);
		expect(locationChars).toBeLessThan(absoluteLocationChars / 4);
	});
});
