import type { TipDefinition } from "./types.ts";

function stopChord(): string {
	return process.platform === "darwin" ? "Control+Option+Command+Escape" : "Ctrl+Alt+Shift+Escape";
}

export const COMPUTER_TIPS = [
	{
		id: "computer.what-it-is",
		bindings: [],
		requiresCommand: "computer",
		render: () =>
			"Experimental: your agent can use native apps too: screenshots, windows, clicks and typing. Run /computer to see whether this machine is ready.",
	},
	{
		id: "computer.stop-chord",
		bindings: [],
		requiresCommand: "computer",
		render: () =>
			`Press ${stopChord()} at any moment to stop computer input. It stays stopped until you run /computer resume; the agent cannot resume it.`,
	},
	{
		id: "computer.background-input",
		bindings: [],
		requiresCommand: "computer",
		render: () =>
			"Computer use clicks and types into the target app in the background, so your frontmost app, keyboard focus and cursor stay where you left them.",
	},
	{
		id: "computer.look-dont-touch",
		bindings: [],
		requiresCommand: "computer",
		render: () =>
			"Want the agent to look but not touch? Start with --permission computer:exec=deny: screenshots and accessibility reads still work, clicks and typing are refused.",
	},
	{
		id: "computer.permissions",
		bindings: [],
		requiresCommand: "computer",
		render: () =>
			"On macOS, computer use needs Screen Recording and Accessibility for the app you launch from. /computer status shows which one is missing.",
	},
] satisfies readonly TipDefinition[];
