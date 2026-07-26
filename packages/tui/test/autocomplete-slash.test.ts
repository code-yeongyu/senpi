import assert from "node:assert";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

const getSuggestions = (provider: CombinedAutocompleteProvider, line: string) =>
	provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });

describe("CombinedAutocompleteProvider slash command suggestions", () => {
	it("ranks longer prefix matches before shorter commands when the typed slash command is ambiguous", async () => {
		// Given
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "session", description: "Show session info and stats" },
				{ name: "sessions", description: "Peek at previous session transcripts in a HUD" },
			],
			"/tmp",
		);

		// When
		const result = await getSuggestions(provider, "/sessio");

		// Then
		assert.deepStrictEqual(
			result?.items.map((item) => item.value),
			["sessions", "session"],
		);
	});

	it("keeps exact slash command matches before longer commands", async () => {
		// Given
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "session", description: "Show session info and stats" },
				{ name: "sessions", description: "Peek at previous session transcripts in a HUD" },
			],
			"/tmp",
		);

		// When
		const result = await getSuggestions(provider, "/session");

		// Then
		assert.deepStrictEqual(
			result?.items.map((item) => item.value),
			["session", "sessions"],
		);
	});

	it("reopens only skill suggestions for an executable second leading skill command", async () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "model", description: "Select a model" },
				{ name: "skill:first", description: "First skill" },
				{ name: "skill:second", description: "Second skill" },
			],
			"/tmp",
		);
		const line = "/skill:first /skill:se";

		const result = await getSuggestions(provider, line);

		assert.deepStrictEqual(
			result?.items.map((item) => item.value),
			["skill:second"],
		);
		assert.strictEqual(result?.prefix, "/skill:se");
		const completion = provider.applyCompletion([line], 0, line.length, result!.items[0]!, result!.prefix);
		assert.deepStrictEqual(completion.lines, ["/skill:first /skill:second "]);
		assert.strictEqual(completion.cursorCol, "/skill:first /skill:second ".length);
	});

	it("does not suggest skill commands outside an executable leading run", async () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "model", description: "Select a model" },
				{ name: "skill:first", description: "First skill" },
				{ name: "skill:second", description: "Second skill" },
			],
			"/tmp",
		);

		assert.strictEqual(await getSuggestions(provider, "prose /skill:se"), null);
		assert.strictEqual(await getSuggestions(provider, "/skill:missing /skill:se"), null);
	});
});
