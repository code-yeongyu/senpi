import type { TipDefinition } from "./types.ts";

export const SUBAGENT_TIPS = [
	{
		id: "workflow-skills.plan",
		bindings: [],
		requiresCommand: "tasks",
		render: () => 'Trigger "ulw plan" to get an explored, decision-complete plan in the workflow extension.',
	},
	{
		id: "workflow-skills.start-work",
		bindings: [],
		requiresCommand: "tasks",
		render: () => 'Trigger "$start-work <plan-name>" to execute a plan end-to-end in a fresh session.',
	},
	{
		id: "workflow-skills.ultrawork",
		bindings: [],
		requiresCommand: "tasks",
		render: () => 'Trigger "ulw" or "ulw loop" for a long, evidence-driven autonomous run in ultrawork mode.',
	},
	{
		id: "workflow-skills.research",
		bindings: [],
		requiresCommand: "tasks",
		render: () =>
			'Trigger "ulw-research" for a saturating, citation-backed investigation across the codebase, docs, and the web.',
	},
	{
		id: "workflow-skills.hyperplan",
		bindings: [],
		requiresCommand: "tasks",
		render: () => 'Trigger "hyperplan" to have adversarial reviewers attack a plan before you commit to it.',
	},
	{
		id: "workflow-skills.review",
		bindings: [],
		requiresCommand: "tasks",
		render: () => 'Trigger "review work" to run parallel goal, quality, security, and hands-on QA reviews.',
	},
	{
		id: "workflow-skills.init-deep",
		bindings: [],
		requiresCommand: "tasks",
		render: () => 'Trigger "/init-deep" to map a project and generate a hierarchical AGENTS.md knowledge base.',
	},
	{
		id: "workflow-skills.debugging",
		bindings: [],
		requiresCommand: "tasks",
		render: () =>
			'Trigger "debug this" for parallel hypotheses, a failing regression test, a minimal fix, and real-surface QA.',
	},
	{
		id: "workflow-skills.refactor",
		bindings: [],
		requiresCommand: "tasks",
		render: () => 'Trigger "refactor" for codebase-aware cleanup that pins behavior before changing structure.',
	},
	{
		id: "workflow-skills.remove-ai-slops",
		bindings: [],
		requiresCommand: "tasks",
		render: () =>
			'Trigger "remove AI slop" to lock behavior first, then strip generated-code smells without drive-by rewrites.',
	},
	{
		id: "workflow-skills.visual-qa",
		bindings: [],
		requiresCommand: "tasks",
		render: () => 'Trigger "visual QA" to capture browser or xterm evidence and review web or terminal interfaces.',
	},
	{
		id: "subagent-categories",
		bindings: [],
		requiresCommand: "tasks",
		render: () =>
			"Delegate by category - quick, deep, ultrabrain, architect, artistry, git, writing - each runs on its own model.",
	},
	{
		id: "subagent-commands",
		bindings: [],
		requiresCommand: "tasks",
		render: () => "Use /tasks to see this session's background subagents, and /task-kill to stop one.",
	},
	{
		id: "subagent-config",
		bindings: [],
		requiresCommand: "tasks",
		render: () =>
			"Task extension configuration maps every subagent category to its model, reasoning effort, and fallback chain.",
	},
	{
		id: "subagent-team",
		bindings: [],
		requiresCommand: "tasks",
		render: () =>
			"Ask for a team when one task needs several agents at once: members share a tasklist and report back to you.",
	},
] satisfies readonly TipDefinition[];
