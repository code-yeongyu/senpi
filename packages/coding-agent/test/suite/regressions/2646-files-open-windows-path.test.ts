import { afterEach, describe, expect, it } from "vitest";
import diffExtension from "../../../src/core/extensions/builtin/diff.ts";
import filesExtension from "../../../src/core/extensions/builtin/files.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };
type Handler = (args: string, ctx: unknown) => Promise<void>;

const FILE = "C:\\Users\\me\\open-test.txt";
const GOTO_USAGE_ERROR = "Arguments in `--goto` mode should be in the format of `FILE(:LINE(:CHARACTER))`.";
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
	if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

// Behaves like VS Code's `code` launcher: `-g` with a drive-letter path prints a usage error and exits 0.
function vscodeLikeExec(command: string, args: string[]): ExecResult {
	const line = command === "cmd" ? (args[3] ?? "") : [command, ...args].join(" ");
	const gotoWithDrive = /(^|\s)-g\s/.test(line) && /[A-Za-z]:\\/.test(line);
	return { stdout: "", stderr: gotoWithDrive ? `${GOTO_USAGE_ERROR}\n` : "", code: 0, killed: false };
}

async function pressEnterOnFile(exec: (command: string, args: string[]) => ExecResult) {
	let handler: Handler | undefined;
	const execCalls: string[][] = [];
	const notices: Array<{ message: string; level: string }> = [];
	const pi = {
		registerCommand: (_name: string, options: { handler: Handler }) => {
			handler = options.handler;
		},
		exec: async (command: string, args: string[]) => {
			execCalls.push([command, ...args]);
			return exec(command, args);
		},
	};
	filesExtension(pi as unknown as ExtensionAPI);
	const branch = [
		{
			type: "message",
			message: {
				role: "assistant",
				timestamp: 1,
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: FILE } }],
			},
		},
		{ type: "message", message: { role: "toolResult", toolCallId: "call-1", timestamp: 2 } },
	];
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		hasUI: true,
		cwd: "C:\\Users\\me",
		sessionManager: { getBranch: () => branch },
		ui: {
			notify: (message: string, level: string) => notices.push({ message, level }),
			custom: async (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: () => void,
				) => { handleInput(data: string): void },
			) => {
				factory({ requestRender: () => {} }, theme, {}, () => {}).handleInput("\r");
			},
		},
	};
	if (!handler) throw new Error("/files was not registered");
	await handler("", ctx);
	await new Promise((resolve) => setImmediate(resolve));
	return { execCalls, notices };
}

describe("/files opens the selected file in VS Code (senpi#2646)", () => {
	it("opens a drive-letter path on Windows without --goto", async () => {
		setPlatform("win32");
		const { execCalls, notices } = await pressEnterOnFile(vscodeLikeExec);

		expect(execCalls).toEqual([["cmd", "/d", "/s", "/c", `code "${FILE}"`]]);
		expect(notices).toEqual([]);
	});

	it("reports stderr from a launcher that exits 0 instead of swallowing it", async () => {
		setPlatform("win32");
		const { notices } = await pressEnterOnFile(() => ({
			stdout: "",
			stderr: "launcher complained\n",
			code: 0,
			killed: false,
		}));

		expect(notices).toEqual([
			{ message: `code reported a problem opening ${FILE}: launcher complained`, level: "warning" },
		]);
	});

	it("keeps --goto on other platforms", async () => {
		setPlatform("darwin");
		const { execCalls } = await pressEnterOnFile(vscodeLikeExec);

		expect(execCalls).toEqual([["code", "-g", FILE]]);
	});
});

// /diff opens an untracked file through the same `code` helper (the issue names both commands).
async function pressEnterOnUntracked(exec: (command: string, args: string[]) => ExecResult) {
	let handler: Handler | undefined;
	const execCalls: string[][] = [];
	const notices: Array<{ message: string; level: string }> = [];
	const pi = {
		registerCommand: (_name: string, options: { handler: Handler }) => {
			handler = options.handler;
		},
		exec: async (command: string, args: string[]) => {
			if (command === "git" && args[0] === "status")
				return { stdout: "?? notes.txt\n", stderr: "", code: 0, killed: false };
			execCalls.push([command, ...args]);
			return exec(command, args);
		},
	};
	diffExtension(pi as unknown as ExtensionAPI);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		hasUI: true,
		cwd: "C:\\Users\\me",
		ui: {
			notify: (message: string, level: string) => notices.push({ message, level }),
			custom: async (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: () => void,
				) => { handleInput(data: string): void },
			) => {
				factory({ requestRender: () => {} }, theme, {}, () => {}).handleInput("\r");
			},
		},
	};
	if (!handler) throw new Error("/diff was not registered");
	await handler("", ctx);
	await new Promise((resolve) => setImmediate(resolve));
	return { execCalls, notices };
}

describe("/diff opens an untracked file in VS Code (senpi#2646)", () => {
	it("opens it on Windows without --goto", async () => {
		setPlatform("win32");
		const { execCalls, notices } = await pressEnterOnUntracked(vscodeLikeExec);

		expect(execCalls).toEqual([["cmd", "/d", "/s", "/c", 'code "notes.txt"']]);
		expect(notices).toEqual([]);
	});

	it("reports stderr from a launcher that exits 0 instead of swallowing it", async () => {
		setPlatform("win32");
		const { notices } = await pressEnterOnUntracked(() => ({
			stdout: "",
			stderr: "launcher complained\n",
			code: 0,
			killed: false,
		}));

		expect(notices).toEqual([
			{ message: "code reported a problem opening notes.txt: launcher complained", level: "warning" },
		]);
	});

	it("keeps --goto on other platforms", async () => {
		setPlatform("darwin");
		const { execCalls } = await pressEnterOnUntracked(vscodeLikeExec);

		expect(execCalls).toEqual([["code", "-g", "notes.txt"]]);
	});
});
