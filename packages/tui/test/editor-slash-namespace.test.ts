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

const COMMANDS = [
	{ name: "model", description: "Select a model" },
	{ name: "skill:debugging", description: "Debug runtime failures" },
	{ name: "skill:ulw-plan", description: "Create an implementation plan" },
];

// Hands each suggestion result to the test in order, so it can await the editor's own requests
// instead of sleeping.
function recordingProvider(): {
	provider: AutocompleteProvider;
	nextSuggestions(label: string): Promise<AutocompleteSuggestions | null>;
} {
	const base = new CombinedAutocompleteProvider(COMMANDS, "/tmp");
	const settled: (AutocompleteSuggestions | null)[] = [];
	const waiters: ((value: AutocompleteSuggestions | null) => void)[] = [];
	const provider: AutocompleteProvider = {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const result = await base.getSuggestions(lines, cursorLine, cursorCol, options);
			const waiter = waiters.shift();
			if (waiter) waiter(result);
			else settled.push(result);
			return result;
		},
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
			base.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
	};
	const nextSuggestions = (label: string) => {
		const ready = settled.shift();
		const next =
			ready !== undefined
				? Promise.resolve(ready)
				: new Promise<AutocompleteSuggestions | null>((resolve) => waiters.push(resolve));
		return Promise.race([
			next,
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error(`editor never requested suggestions: ${label}`)), 2000);
			}),
		]);
	};
	return { provider, nextSuggestions };
}

async function openNamespaceRow(editor: Editor, nextSuggestions: (label: string) => Promise<unknown>) {
	editor.handleInput("/sk");
	for (;;) {
		const suggestions = (await nextSuggestions("typing /sk")) as AutocompleteSuggestions | null;
		if (suggestions?.items[0]?.value === "skill:") break;
	}
	await Promise.resolve();
	assert.strictEqual(editor.isShowingAutocomplete(), true);
}

describe("Editor slash namespace row", () => {
	for (const [key, data] of [
		["Enter", "\r"],
		["Tab", "\t"],
	] as const) {
		it(`${key} on the skill: row lists the skills instead of submitting`, async () => {
			const { provider, nextSuggestions } = recordingProvider();
			const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
			editor.setAutocompleteProvider(provider);
			const submitted: string[] = [];
			editor.onSubmit = (text) => submitted.push(text);
			await openNamespaceRow(editor, nextSuggestions);

			editor.handleInput(data);
			const drilled = await nextSuggestions(`${key} on skill:`);
			await Promise.resolve();

			assert.deepStrictEqual(submitted, []);
			assert.strictEqual(editor.getText(), "/skill:");
			assert.deepStrictEqual(
				drilled?.items.map((item) => item.value),
				["skill:debugging", "skill:ulw-plan"],
			);
			assert.strictEqual(editor.isShowingAutocomplete(), true);
		});
	}

	it("Enter on an ordinary command row still submits it in one press", async () => {
		const { provider, nextSuggestions } = recordingProvider();
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		const submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);

		editor.handleInput("/mod");
		await nextSuggestions("typing /mod");
		await Promise.resolve();
		editor.handleInput("\r");

		assert.deepStrictEqual(submitted, ["/model"]);
	});

	it("openAutocomplete lists the skills after a programmatic /skill: setText", async () => {
		const { provider, nextSuggestions } = recordingProvider();
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		editor.setAutocompleteProvider(provider);

		editor.setText("/skill:");
		editor.openAutocomplete();
		const suggestions = await nextSuggestions("openAutocomplete");
		await Promise.resolve();

		assert.deepStrictEqual(
			suggestions?.items.map((item) => item.value),
			["skill:debugging", "skill:ulw-plan"],
		);
		assert.strictEqual(editor.isShowingAutocomplete(), true);
	});
});
