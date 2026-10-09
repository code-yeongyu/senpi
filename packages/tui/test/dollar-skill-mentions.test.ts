import assert from "node:assert";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { findDollarSkillMentions } from "../src/dollar-invocation-autocomplete.ts";

const knownSkills = new Set(["debugging", "frontend"]);

describe("findDollarSkillMentions", () => {
	it("finds every boundary token that names a known skill", () => {
		const line = "fix $debugging then $frontend please";

		assert.deepStrictEqual(findDollarSkillMentions(line, knownSkills), [
			{ start: 4, end: 14, name: "debugging" },
			{ start: 20, end: 29, name: "frontend" },
		]);
	});

	it("resolves the explicit skill namespace and keeps the whole token", () => {
		assert.deepStrictEqual(findDollarSkillMentions("$skill:debugging go", knownSkills), [
			{ start: 0, end: 16, name: "debugging" },
		]);
	});

	it("leaves unknown, shell-style, positional, and embedded dollars plain", () => {
		const line = "echo $HOME $1 $missing a$debugging $debugging-x";

		assert.deepStrictEqual(findDollarSkillMentions(line, knownSkills), []);
	});

	it("does not mention anything when no skills are loaded", () => {
		assert.deepStrictEqual(findDollarSkillMentions("$debugging", new Set()), []);
	});
});

describe("CombinedAutocompleteProvider.getMentionRanges", () => {
	it("maps the command list's skill entries onto mention ranges", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "model", description: "Select a model" },
				{ name: "skill:debugging", description: "Debug runtime failures" },
			],
			"/tmp",
		);

		assert.deepStrictEqual(provider.getMentionRanges("$model $debugging"), [{ start: 7, end: 17 }]);
	});
});
