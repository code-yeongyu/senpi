import type { TipDefinition } from "./types.ts";

export const INPUT_TIPS = [
	{
		id: "queue-follow-up",
		bindings: ["app.message.followUp"],
		render: (keys) =>
			`While the agent is working, use ${keys("app.message.followUp")} to queue a follow-up for after it finishes.`,
	},
	{
		id: "steering-message",
		bindings: ["tui.input.submit", "app.message.followUp"],
		render: (keys) =>
			`Press ${keys("tui.input.submit")} while the agent works to steer it after the current tool batch; ${keys("app.message.followUp")} waits until all work is done.`,
	},
	{
		id: "edit-queued-message",
		bindings: ["app.message.dequeue"],
		render: (keys) => `Use ${keys("app.message.dequeue")} to bring queued messages back for editing.`,
	},
	{
		id: "interrupt-restores-queue",
		bindings: ["app.interrupt"],
		render: (keys) =>
			`Press ${keys("app.interrupt")} to abort the current turn and restore queued messages to the editor.`,
	},
	{
		id: "file-reference",
		bindings: [],
		render: () => "Type @ in the editor to fuzzy-search project files and insert their paths.",
	},
	{
		id: "path-completion",
		bindings: ["tui.input.tab"],
		render: (keys) => `Press ${keys("tui.input.tab")} to complete file paths while typing.`,
	},
	{
		id: "shortcut-overlay",
		bindings: [],
		render: () => "Type ? in an empty editor to pop up the full shortcut grid.",
	},
	{
		id: "prompt-history",
		bindings: ["app.history.search"],
		requiresCommand: "history",
		render: (keys) => `Search prompt history across sessions with ${keys("app.history.search")}.`,
	},
	{
		id: "external-editor",
		bindings: ["app.editor.external"],
		render: (keys) => `Open the current prompt in your external editor with ${keys("app.editor.external")}.`,
	},
	{
		id: "expand-tool-output",
		bindings: ["app.tools.expand"],
		render: (keys) =>
			`Cycle tool output through collapsed, expanded, and atomic modes with ${keys("app.tools.expand")}.`,
	},
	{
		id: "thinking-blocks",
		bindings: ["app.thinking.toggle"],
		render: (keys) => `Collapse or expand thinking blocks with ${keys("app.thinking.toggle")}.`,
	},
	{
		id: "paste-image",
		bindings: ["app.clipboard.pasteImage"],
		render: (keys) => `Paste an image from the clipboard with ${keys("app.clipboard.pasteImage")}.`,
	},
	{
		id: "copy-message",
		bindings: ["app.message.copy"],
		render: (keys) => `Copy the latest assistant message with ${keys("app.message.copy")}.`,
	},
	{
		id: "input-newline",
		bindings: ["tui.input.newLine"],
		render: (keys) => `Insert a newline without sending with ${keys("tui.input.newLine")}.`,
	},
	{
		id: "bash-prefixes",
		bindings: [],
		render: () => "Prefix a prompt with ! to run bash, or !! to run bash without adding its output to model context.",
	},
	{
		id: "drag-drop-files",
		bindings: [],
		render: () => "Drag and drop files into the terminal to add their paths to your prompt.",
	},
] satisfies readonly TipDefinition[];
