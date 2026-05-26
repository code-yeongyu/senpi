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
});
