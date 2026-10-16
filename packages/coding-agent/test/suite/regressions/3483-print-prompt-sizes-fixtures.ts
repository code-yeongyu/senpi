import type { BuildDynamicSystemPromptOptions } from "../../../src/core/dynamic-prompt/build.ts";
import type { Skill } from "../../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";

export const memoryBlock = "\n\n<memory-projection>\nPRIVATE_EXTENSION_3483 기억\n</memory-projection>";

export function fixtureSkill(index: number): Skill {
	const roots = ["/fixture/home/.senpi/agent/skills", "/fixture/project/.senpi/skills", "/fixture/settings/skills"];
	const baseDir = `${roots[index % roots.length]}/skill-${index}`;
	const filePath = `${baseDir}/SKILL.md`;
	return {
		name: `skill-${index}`,
		description: `PRIVATE_SKILL_3483_${index} Review source and verify behavior.\nKeep the full description.`,
		filePath,
		baseDir,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "fixture" }),
		disableModelInvocation: false,
	};
}

export const realisticOptions: BuildDynamicSystemPromptOptions = {
	appName: "senpi",
	cwd: "/fixture/project/nested",
	selectedTools: ["read", "bash"],
	toolSnippets: { read: "Read a file.", bash: "Run a command." },
	promptGuidelines: ["Keep tool output bounded."],
	contextFiles: [
		{ path: "/fixture/home/AGENTS.md", content: "PRIVATE_AGENTS_3483 Global instructions.\n\n" },
		{ path: "/fixture/project/AGENTS.md", content: "Project instructions: 한글 and UTF-8.\n" },
		{ path: "/fixture/project/nested/AGENTS.md", content: "Nested instructions.\n\n" },
	],
	skills: [fixtureSkill(0), fixtureSkill(1), fixtureSkill(2)],
	tuningSection: "\nModel tuning.\n",
};

// Captured from main 89ecd50ca0 before the parts refactor. These inputs deliberately
// exercise whitespace, multiple resource roots, and the >100-skill compact path.
export const goldenCases = [
	{ name: "realistic", options: realisticOptions },
	{
		name: "compact",
		options: { ...realisticOptions, skills: Array.from({ length: 101 }, (_, i) => fixtureSkill(i)) },
	},
	{ name: "app", options: { ...realisticOptions, surface: "app" as const, contextFiles: [], skills: [] } },
	{ name: "core", options: { ...realisticOptions, corePrompt: () => "Custom model core.\n" } },
	{ name: "custom", options: { ...realisticOptions, customPrompt: "Loader system prompt.\n" } },
	{ name: "append", options: { ...realisticOptions, appendSystemPrompt: "Append one.\n\nAppend two.\n" } },
	{
		name: "custom-append",
		options: { ...realisticOptions, customPrompt: "Loader system prompt.\n", appendSystemPrompt: "Append.\n" },
	},
];
