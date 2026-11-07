import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { normalizeWindowsTerminalCtrlJInput } from "../src/windows-terminal-input.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const WT_SESSION = "6f3c2a1e-9b4d-4c8e-a7f2-1d0e5b6c7a89";
const CTRL_J_SEQUENCE = "\x1b[106;5u";

function editorIn(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { editor: Editor; submitted: string[] } {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme, {
		terminalEnvironment: env,
		terminalPlatform: platform,
	});
	const submitted: string[] = [];
	editor.onSubmit = (text) => {
		submitted.push(text);
	};
	return { editor, submitted };
}

describe("Windows Terminal Ctrl+J (senpi#611)", () => {
	for (const [label, env, platform] of [
		["WSL", { WT_SESSION, WSL_DISTRO_NAME: "Ubuntu" }, "linux"],
		["native Windows", { WT_SESSION }, "win32"],
	] as const) {
		it(`inserts a newline for the LF Ctrl+J sends in Windows Terminal (${label})`, () => {
			const { editor, submitted } = editorIn(env, platform);
			editor.setText("first");
			editor.handleInput("\n");
			assert.strictEqual(editor.getText(), "first\n");
			assert.deepStrictEqual(submitted, []);
		});

		it(`keeps CR Enter submitting in Windows Terminal (${label})`, () => {
			const { editor, submitted } = editorIn(env, platform);
			editor.setText("first");
			editor.handleInput("\r");
			assert.deepStrictEqual(submitted, ["first"]);
		});
	}

	it("rewrites only a standalone LF, and only for a direct Windows Terminal session", () => {
		assert.strictEqual(normalizeWindowsTerminalCtrlJInput("\n", { WT_SESSION }, "linux"), CTRL_J_SEQUENCE);
		assert.strictEqual(normalizeWindowsTerminalCtrlJInput("\r", { WT_SESSION }, "linux"), "\r");
		assert.strictEqual(normalizeWindowsTerminalCtrlJInput("a\n", { WT_SESSION }, "linux"), "a\n");
		const untouched: ReadonlyArray<readonly [string, NodeJS.ProcessEnv, NodeJS.Platform]> = [
			["no marker", {}, "linux"],
			["blank marker", { WT_SESSION: " " }, "linux"],
			["non-GUID marker", { WT_SESSION: "yes" }, "linux"],
			["tmux", { WT_SESSION, TMUX: "/tmp/tmux-1000/default,1,0" }, "linux"],
			["ssh", { WT_SESSION, SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" }, "linux"],
			["inherited by another terminal", { WT_SESSION, TERM_PROGRAM: "vscode" }, "win32"],
			["macOS", { WT_SESSION }, "darwin"],
		];
		for (const [label, env, platform] of untouched) {
			assert.strictEqual(normalizeWindowsTerminalCtrlJInput("\n", env, platform), "\n", label);
		}
	});

	it("leaves bare-LF Enter submitting outside Windows Terminal", () => {
		const { editor, submitted } = editorIn({}, "linux");
		editor.setText("first");
		editor.handleInput("\n");
		assert.deepStrictEqual(submitted, ["first"]);
	});
});
