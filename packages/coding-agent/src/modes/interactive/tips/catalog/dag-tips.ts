import type { TipDefinition } from "./types.ts";

export const DAG_TIPS = [
	{
		id: "dag.one-keyword-mastery",
		bindings: [],
		requiresCommand: "dag",
		render: () =>
			'One keyword makes you a master of graph engineering: say "mass-ulw" and your work becomes a dependency graph that schedules itself.',
	},
	{
		id: "dag.what-it-is",
		bindings: [],
		requiresCommand: "dag",
		render: () =>
			'Trigger "mass-ulw" when some tasks must wait for others - describe the work, get a graph that runs in the right order.',
	},
	{
		id: "dag.parallel-waves",
		bindings: [],
		requiresCommand: "dag",
		render: () =>
			"A graph run executes in waves: everything with no pending dependency starts at once, the rest starts the moment it is unblocked.",
	},
	{
		id: "dag.depends-on",
		bindings: [],
		requiresCommand: "dag",
		render: () =>
			"Say what needs what - review after implementation, docs after both - and the ordering is enforced for you.",
	},
	{
		id: "dag.categories",
		bindings: [],
		requiresCommand: "dag",
		render: () =>
			"Each node in the graph picks its own worker category, so cheap steps stay cheap and hard steps get the strong model.",
	},
	{
		id: "dag.status-view",
		bindings: [],
		requiresCommand: "dag",
		render: () => "Use /dag to watch a run: which nodes finished, which are running, and which one failed.",
	},
	{
		id: "dag.resume",
		bindings: [],
		requiresCommand: "dag",
		render: () =>
			"Graph runs are journaled - if the session dies mid-run it resumes later and never redoes the nodes that already finished.",
	},
	{
		id: "dag.vs-parallel",
		bindings: [],
		requiresCommand: "dag",
		render: () =>
			"Fully independent jobs just need parallel subagents; reach for a graph when the ordering between them is the whole point.",
	},
	{
		id: "dag.scale",
		bindings: [],
		requiresCommand: "dag",
		render: () =>
			"Stop hand-running steps in sequence. Describe the dependencies once and let a dozen agents fan out and rejoin on their own.",
	},
] satisfies readonly TipDefinition[];
