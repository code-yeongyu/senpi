import assert from "node:assert/strict";
import { test } from "node:test";
import { RUNTIME_GATED, unmatchedGatedRemovals, withoutRuntimeGated } from "./node-smoke-gating.mjs";

const prompt = (skillRoots, skills, kernelLine) =>
	`<skill_roots>\n  <r0><repo>/packages/coding-agent/src/core/extensions/builtin/imagegen</r0>${skillRoots}\n</skill_roots>\n<available_skills>\n  <skill>\n    <name>gpt-image-gen</name>\n    <description>Images.</description>\n    <location>r0/skill/SKILL.md</location>\n  </skill>${skills}\n</available_skills>\nRun one step of code.${kernelLine}\nEnd.`;
const bunSkill =
	"\n  <skill>\n    <name>bun</name>\n    <description>Read before a js eval cell: this session&apos;s eval js kernel runs Bun 1.4+.</description>\n    <location>r1/bun/SKILL.md</location>\n  </skill>";
const bunRun = prompt(
	"\n  <r1><repo>/packages/senpi-codemode/src/skill</r1>",
	bunSkill,
	"\nJS runs in-process on Bun 1.4.4: fast.",
);
const nodeRun = prompt("", "", "\nJS runs under Node.js worker: isolated.");
const strip = (runtime, text) => {
	const counts = Object.fromEntries(RUNTIME_GATED[runtime].map(([name]) => [name, 0]));
	return { text: withoutRuntimeGated({ O1: [{ content: text }] }, RUNTIME_GATED[runtime], counts).O1[0].content, counts };
};

test("the Bun run's codemode skill (current name 'bun'), its root and kernel line are removed, leaving the Node prompt", () => {
	const bun = strip("bun", bunRun);
	const node = strip("node", nodeRun);
	assert.equal(bun.text, node.text);
	assert.deepEqual(bun.counts, { removedSkillRoots: 1, removedSkillEntries: 1, removedKernelRuntimeLines: 1 });
	assert.deepEqual(unmatchedGatedRemovals({ bun: bun.counts, node: node.counts }), []);
});

test("a designed difference that matched nothing is reported, so a renamed skill fails the smoke loudly", () => {
	const renamed = bunRun.replaceAll("<name>bun</name>", "<name>bun-next</name>").replace("r1/bun/", "r1/bun-next/");
	const bun = strip("bun", renamed);
	assert.equal(bun.counts.removedSkillEntries, 0);
	assert.deepEqual(unmatchedGatedRemovals({ bun: bun.counts, node: strip("node", nodeRun).counts }), [
		"bun.removedSkillEntries",
	]);
});
