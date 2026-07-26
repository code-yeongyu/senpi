import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { TODO_TOOL_DESCRIPTION } from "../../src/core/extensions/builtin/todotools/prompt.ts";
import { TODO_PARAMS_SCHEMA } from "../../src/core/extensions/builtin/todotools/tools/todo.ts";

// Behavioral guards for the TODO_TOOL_DESCRIPTION guidance additions (plan
// todo 6). Assertions target structure/parseability, never full sentences.

const lines = TODO_TOOL_DESCRIPTION.split("\n");

const exampleLine = lines.find((line) => line.startsWith("Example:"));
const exampleJson = exampleLine ? exampleLine.slice("Example:".length).trim() : "";

let parsed: unknown = null;
let parseError: string | null = null;
if (exampleJson) {
	try {
		parsed = JSON.parse(exampleJson);
	} catch (err) {
		parseError = err instanceof Error ? err.message : String(err);
	}
}

describe("todo prompt guidance", () => {
	it("exposes a canonical Example: line directly under the Operations table", () => {
		expect(exampleLine, "TODO_TOOL_DESCRIPTION must contain an 'Example:' line").toBeDefined();
	});

	it("the Example line is valid JSON", () => {
		expect(parseError, `Example JSON did not parse: ${parseError ?? ""}`).toBeNull();
	});

	it("the Example payload validates against TODO_PARAMS_SCHEMA", () => {
		expect(Value.Check(TODO_PARAMS_SCHEMA, parsed), "Example payload must satisfy TODO_PARAMS_SCHEMA").toBe(true);
	});

	it("the append Operations row marks phase as optional (phase?)", () => {
		const appendRow = lines.find((line) => line.startsWith("| append |"));
		expect(appendRow, "append row must exist in the Operations table").toBeDefined();
		expect(appendRow ?? "", "append phase must be marked optional").toContain("phase?");
	});

	it("does not advertise auto-correction in the description", () => {
		expect(TODO_TOOL_DESCRIPTION.toLowerCase()).not.toContain("auto-correct");
	});
});
