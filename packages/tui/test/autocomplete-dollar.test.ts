import assert from "node:assert";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

const commands = [
	{ name: "model", description: "Select a model" },
	{ name: "reload", description: "Reload extensions" },
	{ name: "skill:debugging", description: "Debug runtime failures" },
	{ name: "skill:frontend", description: "Build web interfaces" },
];

const getSuggestions = (provider: CombinedAutocompleteProvider, line: string, cursorRow = 0) =>
	provider.getSuggestions([line], cursorRow, line.length, { signal: new AbortController().signal });

describe("CombinedAutocompleteProvider dollar invocation suggestions", () => {
	it("groups canonical commands before skills for a leading dollar trigger", async () => {
		const provider = new CombinedAutocompleteProvider(commands, "/tmp");

		const result = await getSuggestions(provider, "$");

		assert.deepStrictEqual(
			result?.items.map((item) => item.value),
			["/model", "/reload", "$debugging", "$frontend"],
		);
		assert.strictEqual(result?.prefix, "$");
	});

	it("filters commands and skills through the same dollar query", async () => {
		const provider = new CombinedAutocompleteProvider(commands, "/tmp");

		assert.deepStrictEqual(
			(await getSuggestions(provider, "$rel"))?.items.map((item) => item.value),
			["/reload"],
		);
		assert.deepStrictEqual(
			(await getSuggestions(provider, "$deb"))?.items.map((item) => item.value),
			["$debugging"],
		);
	});

	it("inserts canonical slash commands and bare leading dollar skills", async () => {
		const provider = new CombinedAutocompleteProvider(commands, "/tmp");
		const command = await getSuggestions(provider, "$rel");
		const skill = await getSuggestions(provider, "$deb");

		assert.deepStrictEqual(provider.applyCompletion(["$rel"], 0, 4, command!.items[0]!, command!.prefix), {
			lines: ["/reload "],
			cursorLine: 0,
			cursorCol: "/reload ".length,
		});
		assert.deepStrictEqual(provider.applyCompletion(["$deb"], 0, 4, skill!.items[0]!, skill!.prefix), {
			lines: ["$debugging "],
			cursorLine: 0,
			cursorCol: "$debugging ".length,
		});
	});

	it("reopens only known skills for a second leading dollar token", async () => {
		const provider = new CombinedAutocompleteProvider(commands, "/tmp");
		const line = "$debugging $front";

		const result = await getSuggestions(provider, line);

		assert.deepStrictEqual(
			result?.items.map((item) => item.value),
			["$frontend"],
		);
		assert.strictEqual(result?.prefix, "$front");
		assert.deepStrictEqual(provider.applyCompletion([line], 0, line.length, result!.items[0]!, result!.prefix), {
			lines: ["$debugging $frontend "],
			cursorLine: 0,
			cursorCol: "$debugging $frontend ".length,
		});
	});

	it("does not offer dollar invocations outside a valid prompt-leading run", async () => {
		const provider = new CombinedAutocompleteProvider(commands, "/tmp");

		assert.strictEqual(await getSuggestions(provider, "explain $deb"), null);
		assert.strictEqual(await getSuggestions(provider, "$missing $deb"), null);
		assert.strictEqual(await getSuggestions(provider, "$deb", 1), null);
	});
});
