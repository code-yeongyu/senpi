import assert from "node:assert";
import { describe, it } from "node:test";
import type { AutocompleteProvider, AutocompleteSuggestions } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("Editor dollar autocomplete trigger", () => {
	it("requests and renders suggestions when the prompt starts with dollar", async () => {
		let resolveRequest!: (value: { text: string; cursorLine: number; cursorCol: number }) => void;
		const requested = new Promise<{ text: string; cursorLine: number; cursorCol: number }>((resolve) => {
			resolveRequest = resolve;
		});
		const suggestions: AutocompleteSuggestions = {
			items: [{ value: "$debugging", label: "$debugging", description: "Debug runtime failures" }],
			prefix: "$deb",
		};
		const provider: AutocompleteProvider = {
			async getSuggestions(lines, cursorLine, cursorCol) {
				resolveRequest({ text: lines[cursorLine] ?? "", cursorLine, cursorCol });
				return suggestions;
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		};
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		editor.setAutocompleteProvider(provider);

		editor.handleInput("$deb");
		const request = await Promise.race([
			requested,
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error("editor did not request dollar autocomplete")), 500);
			}),
		]);
		await Promise.resolve();

		assert.deepStrictEqual(request, { text: "$deb", cursorLine: 0, cursorCol: 4 });
		assert.match(editor.render(80).join("\n"), /\$debugging/);
	});
});
