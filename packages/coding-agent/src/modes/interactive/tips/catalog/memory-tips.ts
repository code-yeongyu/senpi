import { APP_NAME } from "../../../../config.ts";
import type { TipDefinition } from "./types.ts";

export const MEMORY_TIPS = [
	{
		id: "memory.persistent",
		bindings: [],
		requiresCommand: "memory",
		render: () =>
			`${APP_NAME} remembers across sessions. Close the terminal, come back tomorrow, and the context is still there.`,
	},
	{
		id: "memory.remember-command",
		bindings: [],
		requiresCommand: "remember",
		render: () => "Use /remember to save something you want kept - a preference, a decision, a fact worth reusing.",
	},
	{
		id: "memory.just-tell-it",
		bindings: [],
		requiresCommand: "remember",
		render: () =>
			'You can also just say it: "remember that we deploy on Fridays" is enough. No syntax, no file to open.',
	},
	{
		id: "memory.search-command",
		bindings: [],
		requiresCommand: "search",
		render: () => "Use /search to look through everything remembered so far, in plain words.",
	},
	{
		id: "memory.memory-command",
		bindings: [],
		requiresCommand: "memory",
		render: () => "Use /memory to see what is currently remembered about you and this project.",
	},
	{
		id: "memory.init-command",
		bindings: [],
		requiresCommand: "init",
		render: () => "Use /init to start memory for a new project, so it learns this codebase from the first session.",
	},
	{
		id: "memory.people-command",
		bindings: [],
		requiresCommand: "people",
		render: () => "Use /people to keep notes on teammates - who owns what, who to ask, what they prefer.",
	},
	{
		id: "memory.reflect-command",
		bindings: [],
		requiresCommand: "reflect",
		render: () => "Use /reflect to have the session reviewed now and the parts worth keeping written down.",
	},
	{
		id: "memory.dream-command",
		bindings: [],
		requiresCommand: "dream",
		render: () =>
			"Memory tidies itself in the background between turns - /dream shows that work and lets you start it yourself.",
	},
	{
		id: "memory.sleeptime-command",
		bindings: [],
		requiresCommand: "sleeptime",
		render: () => "Use /sleeptime to decide how often memory reorganizes itself while you are not looking.",
	},
	{
		id: "memory.memfs-command",
		bindings: [],
		requiresCommand: "memfs",
		render: () => "Memory is plain files you own - browse them with /memfs and edit anything that looks wrong.",
	},
	{
		id: "memory.repository-command",
		bindings: [],
		requiresCommand: "memory-repository",
		render: () =>
			"Every memory change is a git commit - use /memory-repository to see the history and undo a bad one.",
	},
	{
		id: "memory.doctor-command",
		bindings: [],
		requiresCommand: "doctor",
		render: () => "Use /doctor when memory feels off; it checks the setup and tells you what to fix.",
	},
	{
		id: "memory.facts-command",
		bindings: [],
		requiresCommand: "facts",
		render: () => "Use /facts to see the individual things learned about you, and drop the ones that no longer hold.",
	},
	{
		id: "memory.recompile-command",
		bindings: [],
		requiresCommand: "recompile",
		render: () => "Edited memory files by hand? Run /recompile so this session picks the changes up right away.",
	},
	{
		id: "memory.stop-repeating",
		bindings: [],
		requiresCommand: "memory",
		render: () => "Explain your setup once. Memory means you stop re-explaining it at the start of every session.",
	},
] satisfies readonly TipDefinition[];
