import assert from "node:assert";
import { describe, it } from "node:test";
import type { AutocompleteProvider } from "../src/autocomplete.ts";
import { Editor, type EditorTheme } from "../src/components/editor.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Create a TUI with a virtual terminal for testing */
function createTestTUI(cols = 80, rows = 24): TUI {
	return new TUI(new VirtualTerminal(cols, rows));
}

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Editor threading for the select-list presentation seam (grok-neo todo G6):
 * an EditorTheme whose selectList theme carries `renderRow` must reach the
 * autocomplete/slash list that the private createAutocompleteList() builds.
 */
describe("Editor autocomplete renderRow threading", () => {
	it("routes the editor theme's selectList renderRow into the slash autocomplete list", async () => {
		const editorTheme: EditorTheme = {
			borderColor: (text) => text,
			selectList: {
				selectedPrefix: (text) => `[BLUE]${text}[/BLUE]`,
				selectedText: (text) => `[S]${text}[/S]`,
				description: (text) => `[D]${text}[/D]`,
				scrollInfo: (text) => `[I]${text}[/I]`,
				noMatch: (text) => `[N]${text}[/N]`,
				renderRow: ({ prefix, primary, description, isSelected }) =>
					isSelected
						? `[BG]${prefix}${primary}${description ?? ""}[/BG]`
						: `${prefix}${primary}${description ?? ""}`,
			},
		};
		const editor = new Editor(createTestTUI(), editorTheme);

		const mockProvider: AutocompleteProvider = {
			getSuggestions: async (lines, _cursorLine, cursorCol) => {
				const before = (lines[0] || "").slice(0, cursorCol);
				if (!before.startsWith("/")) return null;
				return {
					items: [
						{ value: "/help", label: "/help", description: "Show help" },
						{ value: "/quit", label: "/quit", description: "Exit the app" },
					],
					prefix: before,
				};
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
				const line = lines[cursorLine] || "";
				const newLines = [...lines];
				newLines[cursorLine] = line.slice(0, cursorCol - prefix.length) + item.value + line.slice(cursorCol);
				return { lines: newLines, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
			},
		};
		editor.setAutocompleteProvider(mockProvider);

		editor.handleInput("/");
		await flushAutocomplete();
		assert.strictEqual(editor.isShowingAutocomplete(), true);

		const rendered = editor.render(80).join("\n");
		// Slash layout clamps the primary column to [12, 32]; "/help" is 5 wide,
		// so the column is 12 and the description starts after 7 spaces.
		assert.ok(
			rendered.includes(`[BG][BLUE]→ [/BLUE]/help${" ".repeat(7)}Show help[/BG]`),
			`expected custom slash row in editor render, got:\n${rendered}`,
		);
		assert.ok(rendered.includes(`  /quit${" ".repeat(7)}Exit the app`), "unselected row should use renderRow too");
	});
});
