import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	collectSkillEntries,
	readSkillMarkdownSource,
	SKILL_FRONTMATTER_PREFIX_BYTES,
} from "../src/core/skill-discovery.ts";
import { loadSkillsFromDir } from "../src/core/skills.ts";
import { parseFrontmatter } from "../src/utils/frontmatter.ts";

const BODY_SENTINEL = "BODY_SENTINEL_MUST_NOT_BE_READ";
const INVALID_YAML_BODY = `{ this is: [ unterminated yaml\n${BODY_SENTINEL}\n`;

function makeTempDir(label: string): string {
	const dir = join(tmpdir(), `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeSkill(root: string, name: string, contents: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, "SKILL.md");
	writeFileSync(filePath, contents);
	return filePath;
}

function discoveredRecord(filePath: string, root: string) {
	const raw = readFileSync(filePath, "utf8");
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(raw);
	const name = typeof frontmatter.name === "string" ? frontmatter.name : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	return {
		name,
		description,
		disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		relativePath: relative(root, filePath).split("\\").join("/"),
	};
}

describe("skills discovery cost", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	describe("bounded SKILL.md frontmatter reads", () => {
		it("loads a skill whose body would throw if parsed as frontmatter", () => {
			tempDir = makeTempDir("skill-body-throws");
			expect(() => parse(INVALID_YAML_BODY)).toThrow();
			writeSkill(
				tempDir,
				"body-throws",
				`---\nname: body-throws\ndescription: Valid frontmatter description.\n---\n${INVALID_YAML_BODY}`,
			);

			const { skills, diagnostics } = loadSkillsFromDir({ dir: tempDir, source: "test" });
			const source = readSkillMarkdownSource(join(tempDir, "body-throws", "SKILL.md"));

			expect(source.includes(BODY_SENTINEL)).toBe(false);
			expect(skills).toHaveLength(1);
			expect(skills[0]?.name).toBe("body-throws");
			expect(skills[0]?.description).toBe("Valid frontmatter description.");
			expect(diagnostics).toHaveLength(0);
		});

		it("loads a skill whose frontmatter exceeds the prefix via fallback", () => {
			tempDir = makeTempDir("skill-long-frontmatter");
			const padding = "x".repeat(SKILL_FRONTMATTER_PREFIX_BYTES);
			const description = "Valid description for a long frontmatter skill.";
			writeSkill(
				tempDir,
				"long-frontmatter",
				`---\nname: long-frontmatter\ndescription: ${description}\npadding: |\n  ${padding}\n---\n# body\n`,
			);

			const { skills, diagnostics } = loadSkillsFromDir({ dir: tempDir, source: "test" });
			const source = readSkillMarkdownSource(join(tempDir, "long-frontmatter", "SKILL.md"));

			expect(source.includes(description)).toBe(true);
			expect(source.includes(padding)).toBe(true);
			expect(skills).toHaveLength(1);
			expect(skills[0]?.name).toBe("long-frontmatter");
			expect(skills[0]?.description).toBe(description);
			expect(diagnostics).toHaveLength(0);
		});
	});

	describe("100-skill fixture identity", () => {
		it("matches the full-file discovered list including skip of node_modules and .git", () => {
			tempDir = makeTempDir("skill-100-fixture");
			const skillsRoot = join(tempDir, "skills");
			mkdirSync(skillsRoot, { recursive: true });
			const body = "B".repeat(20 * 1024);
			for (let i = 0; i < 100; i++) {
				const name = `skill-${String(i).padStart(3, "0")}`;
				writeSkill(
					skillsRoot,
					name,
					`---\nname: ${name}\ndescription: Synthetic skill ${name} for discovery-cost measurement.\n---\n${body}\n`,
				);
			}
			writeSkill(
				join(skillsRoot, "node_modules"),
				"hidden-dep",
				"---\nname: hidden-dep\ndescription: Must not be discovered inside node_modules.\n---\n",
			);
			writeSkill(
				join(skillsRoot, ".git"),
				"hidden-git",
				"---\nname: hidden-git\ndescription: Must not be discovered inside .git.\n---\n",
			);

			const loaded = loadSkillsFromDir({ dir: skillsRoot, source: "test" });
			const expected = collectSkillEntries(skillsRoot, "pi").map((filePath) =>
				discoveredRecord(filePath, skillsRoot),
			);
			const actual = loaded.skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				disableModelInvocation: skill.disableModelInvocation,
				relativePath: relative(skillsRoot, skill.filePath).split("\\").join("/"),
			}));
			writeFileSync(join(skillsRoot, "discovered-golden.json"), `${JSON.stringify(expected)}\n`);

			expect(expected).toHaveLength(100);
			expect(readdirSync(skillsRoot)).toEqual(expect.arrayContaining(["node_modules", ".git"]));
			expect(actual).toEqual(expected);
			expect(actual.map((row) => row.name)).not.toContain("hidden-dep");
			expect(actual.map((row) => row.name)).not.toContain("hidden-git");
			expect(readFileSync(join(skillsRoot, "discovered-golden.json"), "utf8")).toBe(`${JSON.stringify(expected)}\n`);
		});
	});
});
