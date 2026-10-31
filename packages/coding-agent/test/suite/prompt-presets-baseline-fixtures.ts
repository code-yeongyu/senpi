import type { BuildDynamicSystemPromptOptions } from "../../src/core/extensions/builtin/prompt-preset/public.ts";

export const BASELINE_SURFACES = ["terminal", "app", "chat"] as const;

export const WORKSTATION_FACTS = {
	osLine: "linux",
	kernel: "Linux fixture",
	arch: "x64",
	cpu: "Fixture CPU (4 cores)",
	terminal: "fixture-terminal",
};

export const BASELINE_OPTIONS: [BuildDynamicSystemPromptOptions, BuildDynamicSystemPromptOptions] = [
	{
		cwd: "",
		selectedTools: [],
		toolSnippets: {},
		promptGuidelines: [],
		contextFiles: [],
		skills: [],
	},
	{
		cwd: "/fixture",
		selectedTools: ["read", "bash", "grep", "eval", "apply_patch", "todo", "ask_user_question", "web_search"],
		toolSnippets: { read: "READ_SENTINEL", eval: "EVAL_SENTINEL" },
		promptGuidelines: ["GUIDELINE_SENTINEL"],
		contextFiles: [{ path: "/fixture/AGENTS.md", content: "CONTEXT_SENTINEL" }],
		skills: [
			{
				name: "fixture-skill",
				description: "A deterministic fixture skill.",
				filePath: "/fixture/skill/SKILL.md",
				baseDir: "/fixture/skill",
				sourceInfo: { path: "/fixture/skill", source: "fixture", scope: "project", origin: "top-level" },
				disableModelInvocation: false,
			},
		],
	},
];
