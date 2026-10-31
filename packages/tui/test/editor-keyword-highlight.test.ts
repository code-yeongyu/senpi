import assert from "node:assert";
import { describe, it } from "node:test";
import type { AutocompleteProvider } from "../src/autocomplete.ts";
import { Editor, type EditorKeywordHighlight, type EditorTheme } from "../src/components/editor.ts";
import { keywordRangesByLine } from "../src/components/editor-line-render.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const LEFT = "\x1b[D";
const tag = (text: string, index: number, length: number): string => `<${index}/${length}:${text}>`;

const ulwHighlight: EditorKeywordHighlight = {
	find: (text) =>
		[...text.matchAll(/\bulw(?:[\s-]*research)?\b/g)].map((m) => ({ start: m.index, end: m.index + m[0].length })),
	style: tag,
};

const keywordTheme: EditorTheme = { ...defaultEditorTheme, keywordHighlight: ulwHighlight };

function createEditor(theme: EditorTheme = keywordTheme, width = 80): Editor {
	return new Editor(new TuiMainScreen(new VirtualTerminal(width, 24)), theme);
}

const realHighlight: EditorKeywordHighlight = {
	find: ulwHighlight.find,
	style: (text, index) => `\x1b[38;2;${100 + index};0;0m${text}\x1b[39m`,
};

describe("Editor keyword highlight", () => {
	it("styles each keyword character with its offset and run length", () => {
		const editor = createEditor();
		editor.setText("ulw fix the bug");

		const line = editor.render(80)[1] ?? "";

		assert.ok(line.includes("<0/3:u><1/3:l><2/3:w> fix the bug"), JSON.stringify(line));
	});

	it("keeps row width unchanged with real colour escapes, including wide glyphs", () => {
		for (const text of ["ulw fix the bug", "한글 ulw research 문서", "plain sentence"]) {
			const editor = createEditor({ ...defaultEditorTheme, keywordHighlight: realHighlight }, 40);
			editor.setText(text);
			const plainEditor = createEditor(defaultEditorTheme, 40);
			plainEditor.setText(text);
			const styled = editor.render(40);
			const reference = plainEditor.render(40);
			assert.strictEqual(styled.length, reference.length, text);
			for (const [index, row] of styled.entries()) {
				assert.strictEqual(visibleWidth(row), visibleWidth(reference[index] ?? ""), `${text} row ${index}`);
			}
		}
	});

	it("draws the cursor grapheme in reverse video and keeps the gradient around it", () => {
		const editor = createEditor();
		editor.setText("ulw");
		editor.handleInput(LEFT);
		editor.handleInput(LEFT);

		const line = editor.render(80)[1] ?? "";

		assert.ok(line.includes("<0/3:u>\x1b[7ml\x1b[0m<2/3:w>"), JSON.stringify(line));
	});

	it("keeps one gradient across a run that wraps onto the next row", () => {
		const editor = createEditor(keywordTheme, 12);
		editor.setText("abcdefg ulw research");

		const joined = editor.render(12).join("\n");

		assert.ok(joined.includes("<0/12:u>"), joined);
		assert.ok(joined.includes("<11/12:h>"), joined);
	});

	it("lets a mention take precedence over a keyword", () => {
		const provider: AutocompleteProvider = {
			getSuggestions: async () => null,
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
			getMentionRanges: (line) => (line.startsWith("$ulw") ? [{ start: 0, end: 4 }] : []),
		};
		const editor = createEditor({ ...keywordTheme, mention: (text) => `[${text}]` });
		editor.setAutocompleteProvider(provider);
		editor.setText("$ulw then ulw");

		const line = editor.render(80)[1] ?? "";

		assert.ok(line.includes("[$ulw] then <0/3:u>"), JSON.stringify(line));
	});

	it("renders plain text without the hook", () => {
		const editor = createEditor(defaultEditorTheme);
		editor.setText("ulw fix the bug");

		assert.ok((editor.render(80)[1] ?? "").includes("ulw fix the bug"));
	});

	it("splits runs across logical lines with offsets relative to each line", () => {
		const byLine = keywordRangesByLine(["go ulw", "research"], [{ start: 3, end: 15 }]);

		assert.deepStrictEqual(byLine.get(0), [{ start: 3, end: 6, runStart: 3, runLength: 12 }]);
		assert.deepStrictEqual(byLine.get(1), [{ start: 0, end: 8, runStart: -4, runLength: 12 }]);
	});
});
