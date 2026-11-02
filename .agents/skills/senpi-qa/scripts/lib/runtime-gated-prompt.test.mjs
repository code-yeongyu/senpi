import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./common.mjs";
import { createNormalizer, directoryRoots } from "./equivalence-normalize.mjs";
import { withoutRuntimeGated } from "./runtime-gated-prompt.mjs";

const productModule = (...parts) => pathToFileURL(join(repoRoot(), "packages", ...parts)).href;
const SKILLS = productModule("coding-agent", "src", "core", "skills.ts");
const CONTRIBUTION = productModule("senpi-codemode", "src", "extension", "skill-contribution.ts");
const OTHER_SKILL_DIR = join(repoRoot(), "packages", "coding-agent", "src", "core", "extensions", "builtin", "imagegen");

// The catalog the product renders for one ordinary skill plus whatever senpi-codemode bundles at the path the engine
// contributes on Bun (bundledBunSkillPath), and the same catalog without the codemode skills, as a Node run renders it.
const PROBE = `
import { dirname } from "node:path";
const { formatSkillsForPrompt, loadSkillsFromDir } = await import(${JSON.stringify(SKILLS)});
const { bundledBunSkillPath } = await import(${JSON.stringify(CONTRIBUTION)});
const codemodeRoot = dirname(dirname(bundledBunSkillPath()));
const codemode = loadSkillsFromDir({ dir: codemodeRoot, source: "path" }).skills;
const other = { name: "gpt-image-gen", description: "Use when generating images.", filePath: ${JSON.stringify(join(OTHER_SKILL_DIR, "skill", "SKILL.md"))}, disableModelInvocation: false };
process.stdout.write(JSON.stringify({ names: codemode.map((s) => s.name), bun: formatSkillsForPrompt([other, ...codemode]), node: formatSkillsForPrompt([other]) }));
`;

function renderedCatalogs() {
	const seen = JSON.parse(
		execFileSync(process.execPath, ["--input-type=module", "-e", PROBE], { cwd: repoRoot(), encoding: "utf8" }),
	);
	const normalize = createNormalizer({ roots: directoryRoots(repoRoot(), "<repo>") });
	return { names: seen.names, bun: normalize(seen.bun), node: normalize(seen.node) };
}

test("the bun run's catalog minus the codemode skill is the node run's catalog, whatever the skill is named", () => {
	const { names, bun, node } = renderedCatalogs();
	assert.equal(names.length, 1, `senpi-codemode bundles one skill: ${names}`);
	const { value, counts } = withoutRuntimeGated(bun, "bun");
	assert.deepEqual(counts, { removedSkillRoots: 1, removedSkillEntries: 1, removedKernelRuntimeLines: 0 });
	assert.equal(value, node);
});

test("a skill under the codemode root is removed by its root, not its name", () => {
	const prompt = [
		"<skill_roots>",
		"  <r0><repo>/packages/coding-agent/skills</r0>",
		"  <r1><repo>/packages/senpi-codemode/src/skill</r1>",
		"</skill_roots>",
		"<available_skills>",
		"  <skill>\n    <name>kept</name>\n    <description>d</description>\n    <location>r0/kept/SKILL.md</location>\n  </skill>",
		"  <skill>\n    <name>any-future-name</name>\n    <description>d</description>\n    <location>r1/any-future-name/SKILL.md</location>\n  </skill>",
		"</available_skills>",
	].join("\n");
	const { value, counts } = withoutRuntimeGated(prompt, "bun");
	assert.equal(counts.removedSkillEntries, 1);
	assert.match(value, /<name>kept<\/name>/);
	assert.doesNotMatch(value, /any-future-name|senpi-codemode/);
});

test("a codemode root with no entry it can remove fails instead of leaving a silent difference", () => {
	const prompt = "<skill_roots>\n  <r0><repo>/packages/senpi-codemode/src/skill</r0>\n</skill_roots>\n- bun: moved format";
	assert.throws(() => withoutRuntimeGated(prompt, "bun"), /codemode skill root r0 .* no skill entry/);
});
