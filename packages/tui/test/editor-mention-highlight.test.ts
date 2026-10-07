import assert from "node:assert";
import { describe, it } from "node:test";
import type { AutocompleteProvider } from "../src/autocomplete.ts";
import { Editor, type EditorTheme } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const LEFT = "\x1b[D";
const BLUE_BOLD = "\x1b[1;34m";
const RESET = "\x1b[22;39m";
const styled = (text: string): string => `${BLUE_BOLD}${text}${RESET}`;

/** Provider that marks every `$debugging` token so the test owns the range contract. */
const mentionProvider: AutocompleteProvider = {
	getSuggestions: async () => null,
	applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
	getMentionRanges: (line) => {
		const ranges: { start: number; end: number }[] = [];
		for (const match of line.matchAll(/\$debugging/g)) {
			ranges.push({ start: match.index, end: match.index + match[0].length });
		}
		return ranges;
	},
};

const mentionTheme: EditorTheme = {
	...defaultEditorTheme,
	mention: styled,
};

function createEditor(theme: EditorTheme = mentionTheme, width = 80): Editor {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal(width, 24)), theme);
	editor.setAutocompleteProvider(mentionProvider);
	return editor;
}

describe("Editor skill mention highlight", () => {
	it("styles every mention range and leaves the rest of the line plain", () => {
		const editor = createEditor();
		editor.setText("fix $debugging then $HOME $debugging");

		const line = editor.render(80)[1] ?? "";

		assert.ok(line.includes(`fix ${styled("$debugging")} then $HOME ${styled("$debugging")}`), JSON.stringify(line));
		assert.strictEqual(visibleWidth(line), 80);
	});

	it("keeps both halves styled when the cursor sits inside a mention", () => {
		const editor = createEditor();
		editor.setText("$debugging");
		for (let i = 0; i < 4; i++) editor.handleInput(LEFT);

		const line = editor.render(80)[1] ?? "";

		assert.ok(line.includes(`${styled("$debug")}\x1b[7mg\x1b[0m${styled("ing")}`), JSON.stringify(line));
	});

	it("styles a mention on every logical line and across wrap chunks", () => {
		const editor = createEditor(mentionTheme, 12);
		editor.setText("first\nuse $debugging");

		const lines = editor.render(12);

		assert.ok(
			lines.some((line) => line.includes(styled("$debugging"))),
			JSON.stringify(lines),
		);
	});

	it("renders plain text when the theme has no mention style", () => {
		const editor = createEditor(defaultEditorTheme);
		editor.setText("fix $debugging");

		const line = editor.render(80)[1] ?? "";

		assert.ok(line.includes("fix $debugging"), JSON.stringify(line));
		assert.ok(!line.includes(BLUE_BOLD), JSON.stringify(line));
	});
});
