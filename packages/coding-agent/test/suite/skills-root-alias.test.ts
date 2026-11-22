import { afterEach, describe, expect, it, vi } from "vitest";
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

// senpi#5067: SENPI_TEST_WORKSTATION's repoRoot pin shows a root inside the pinned checkout under a synthetic root.
describe("formatSkillsForPrompt under the test-only repoRoot pin", () => {
	const PIN = { cpuModel: "Test CPU", cores: 4, kernel: "TestOS 1.0" };
	const skills = [skill("alpha", "/work/checkout/packages/coding-agent/skills"), skill("gamma", "/opt/plugin/skills")];

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("production (unset) renders the real roots, byte-identical to a pin whose checkout holds none of them", () => {
		vi.stubEnv("SENPI_TEST_WORKSTATION", "");
		const production = formatSkillsForPrompt(skills);
		vi.stubEnv("SENPI_TEST_WORKSTATION", JSON.stringify({ ...PIN, repoRoot: { from: "/elsewhere", to: "/eq" } }));

		expect(formatSkillsForPrompt(skills)).toBe(production);
		expect(production).toContain("<r0>/work/checkout/packages/coding-agent/skills</r0>");
		expect(production).toContain("<r1>/opt/plugin/skills</r1>");
	});

	it("a root inside the pinned checkout is shown under the pinned root; other roots and locations are unchanged", () => {
		vi.stubEnv("SENPI_TEST_WORKSTATION", "");
		const production = formatSkillsForPrompt(skills);
		vi.stubEnv(
			"SENPI_TEST_WORKSTATION",
			JSON.stringify({ ...PIN, repoRoot: { from: "/work/checkout", to: "/eq-synthetic/checkout" } }),
		);

		const pinned = formatSkillsForPrompt(skills);

		expect(pinned).toBe(
			production.replace(
				"<r0>/work/checkout/packages/coding-agent/skills</r0>",
				"<r0>/eq-synthetic/checkout/packages/coding-agent/skills</r0>",
			),
		);
		expect(pinned).not.toContain("/work/checkout");
	});
});
