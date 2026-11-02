import assert from "node:assert";
import { describe, it } from "node:test";
import {
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
} from "../src/autocomplete.ts";
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

	it("requests dollar autocomplete on a later logical line", async () => {
		let resolveRequest: (value: { text: string; cursorLine: number; cursorCol: number }) => void;
		const requested = new Promise<{ text: string; cursorLine: number; cursorCol: number }>((resolve) => {
			resolveRequest = resolve;
		});
		const provider: AutocompleteProvider = {
			async getSuggestions(lines, cursorLine, cursorCol) {
				resolveRequest({ text: lines[cursorLine] ?? "", cursorLine, cursorCol });
				return {
					items: [{ value: "$debugging", label: "$debugging", description: "Debug runtime failures" }],
					prefix: "$",
				};
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		};
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		editor.setAutocompleteProvider(provider);

		editor.handleInput("first line");
		editor.handleInput("\x1b[13;2u");
		editor.handleInput("text $");
		const request = await Promise.race([
			requested,
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error("editor did not request multiline dollar autocomplete")), 500);
			}),
		]);

		assert.deepStrictEqual(request, { text: "text $", cursorLine: 1, cursorCol: 6 });
		assert.match(editor.render(80).join("\n"), /\$debugging/);
	});

	it("reopens dollar autocomplete after a multiline paste and follow-up typing", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "skill:debugging", description: "Debug runtime failures" }],
			"/tmp",
		);
		let resolveRequest: (value: AutocompleteSuggestions | null) => void = () => {};
		const requested = new Promise<AutocompleteSuggestions | null>((resolve) => {
			resolveRequest = resolve;
		});
		const wrappedProvider: AutocompleteProvider = {
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const result = await provider.getSuggestions(lines, cursorLine, cursorCol, options);
				resolveRequest(result);
				return result;
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
				provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
		};
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		editor.setAutocompleteProvider(wrappedProvider);

		editor.handleInput("\x1b[200~first line\ntext $\x1b[201~");
		editor.handleInput("d");
		const result = await requested;

		assert.strictEqual(editor.getText(), "first line\ntext $d");
		assert.deepStrictEqual(
			result?.items.map((item) => item.value),
			["$debugging"],
		);
	});

	it("keeps dollar autocomplete responsive while a previous request is pending", async () => {
		let requestCount = 0;
		let resolveFirst: () => void = () => {};
		let resolveFirstStarted: () => void = () => {};
		let resolveSecondStarted: () => void = () => {};
		let resolveSecond: (value: AutocompleteSuggestions) => void = () => {};
		const first = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		const firstStarted = new Promise<void>((resolve) => {
			resolveFirstStarted = resolve;
		});
		const secondStarted = new Promise<void>((resolve) => {
			resolveSecondStarted = resolve;
		});
		const second = new Promise<AutocompleteSuggestions>((resolve) => {
			resolveSecond = resolve;
		});
		const provider: AutocompleteProvider = {
			async getSuggestions() {
				requestCount += 1;
				if (requestCount === 1) {
					resolveFirstStarted();
					await first;
					return null;
				}
				resolveSecondStarted();
				const result = await second;
				return result;
			},
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		};
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		editor.setAutocompleteProvider(provider);

		editor.handleInput("$");
		await firstStarted;
		editor.handleInput("d");
		resolveFirst();
		await secondStarted;
		resolveSecond({
			items: [{ value: "$debugging", label: "$debugging", description: "Debug runtime failures" }],
			prefix: "$d",
		});
		await second;

		assert.strictEqual(editor.getText(), "$d");
		assert.strictEqual(requestCount, 2);
	});
});
