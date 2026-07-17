import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { coerceAntmlParameters } from "../../src/tool-call-middleware/protocols/antml/coerce-parameters.ts";
import type { Tool } from "../../src/types.ts";

function createTool(parameters: Tool["parameters"]): Tool {
	return {
		name: "probe",
		description: "Probe tool",
		parameters,
	};
}

const editTool = createTool(
	Type.Object({
		file_path: Type.String(),
		edits: Type.Array(
			Type.Object({
				oldText: Type.String(),
				newText: Type.String(),
			}),
		),
	}),
);

describe("coerceAntmlParameters", () => {
	it("filters invented trailing keys inside nested array items (Pi edits[] regression)", () => {
		// given: the exact failure shape from Opus 4.8 against Pi's edit tool
		const rawEdits =
			'[{"oldText":"text to replace","newText":"replacement text","requireUnique":true,"oldText2":"","newText2":""}]';

		// when
		const result = coerceAntmlParameters(
			[
				{ name: "file_path", rawValue: "some/file.py" },
				{ name: "edits", rawValue: rawEdits },
			],
			editTool,
		);

		// then
		expect(result).toEqual({
			file_path: "some/file.py",
			edits: [{ oldText: "text to replace", newText: "replacement text" }],
		});
	});

	it("silently filters unknown top-level parameters", () => {
		// given
		const tool = createTool(Type.Object({ command: Type.String() }));

		// when
		const result = coerceAntmlParameters(
			[
				{ name: "command", rawValue: "echo hi" },
				{ name: "requireUnique", rawValue: "true" },
			],
			tool,
		);

		// then
		expect(result).toEqual({ command: "echo hi" });
	});

	it("resolves documented parameter aliases to schema names", () => {
		// given
		const tool = createTool(
			Type.Object({
				file_path: Type.String(),
				old_string: Type.String(),
				new_string: Type.String(),
			}),
		);

		// when
		const result = coerceAntmlParameters(
			[
				{ name: "path", rawValue: "a.py" },
				{ name: "old_str", rawValue: "before" },
				{ name: "new_str", rawValue: "after" },
			],
			tool,
		);

		// then
		expect(result).toEqual({ file_path: "a.py", old_string: "before", new_string: "after" });
	});

	it("matches parameter names across case and separator conventions", () => {
		// given
		const tool = createTool(Type.Object({ oldText: Type.String(), newText: Type.String() }));

		// when
		const result = coerceAntmlParameters(
			[
				{ name: "old_text", rawValue: "a" },
				{ name: "NewText", rawValue: "b" },
			],
			tool,
		);

		// then
		expect(result).toEqual({ oldText: "a", newText: "b" });
	});

	it("resolves nested object keys through the same alias table", () => {
		// given: Pi-style oldText schema receiving Claude-Code-style old_str keys
		const result = coerceAntmlParameters(
			[
				{ name: "file_path", rawValue: "b.py" },
				{ name: "edits", rawValue: '[{"old_str":"x","new_str":"y"}]' },
			],
			editTool,
		);

		// then
		expect(result).toEqual({ file_path: "b.py", edits: [{ oldText: "x", newText: "y" }] });
	});

	it("keeps the last value when a parameter repeats", () => {
		// given
		const tool = createTool(Type.Object({ command: Type.String() }));

		// when
		const result = coerceAntmlParameters(
			[
				{ name: "command", rawValue: "first" },
				{ name: "command", rawValue: "second" },
			],
			tool,
		);

		// then
		expect(result).toEqual({ command: "second" });
	});

	it("repairs broken unicode escapes inside JSON parameters", () => {
		// given
		const tool = createTool(Type.Object({ options: Type.Object({ text: Type.String() }) }));

		// when
		const result = coerceAntmlParameters(
			[{ name: "options", rawValue: String.raw`{"text":"bad\uZZZZescape"}` }],
			tool,
		);

		// then
		expect(result).toEqual({ options: { text: String.raw`bad\uZZZZescape` } });
	});

	it("replaces lone surrogates in string values", () => {
		// given
		const tool = createTool(Type.Object({ message: Type.String() }));

		// when
		const result = coerceAntmlParameters([{ name: "message", rawValue: `a${"\uD800"}b` }], tool);

		// then
		expect(result).toEqual({ message: "a\uFFFDb" });
	});

	it("coerces tolerant scalar spellings for booleans and numbers", () => {
		// given
		const tool = createTool(
			Type.Object({
				enabled: Type.Boolean(),
				verbose: Type.Boolean(),
				count: Type.Number(),
				index: Type.Integer(),
			}),
		);

		// when
		const result = coerceAntmlParameters(
			[
				{ name: "enabled", rawValue: " TRUE " },
				{ name: "verbose", rawValue: '"false"' },
				{ name: "count", rawValue: " 1.25 " },
				{ name: "index", rawValue: '"2"' },
			],
			tool,
		);

		// then
		expect(result).toEqual({ enabled: true, verbose: false, count: 1.25, index: 2 });
	});

	it("rejects values that stay invalid after every repair", () => {
		// given
		const numberTool = createTool(Type.Object({ count: Type.Number() }));
		const integerTool = createTool(Type.Object({ index: Type.Integer() }));
		const arrayTool = createTool(Type.Object({ items: Type.Array(Type.String()) }));

		// when / then
		expect(coerceAntmlParameters([{ name: "count", rawValue: "not-a-number" }], numberTool)).toBeNull();
		expect(coerceAntmlParameters([{ name: "index", rawValue: "1.5" }], integerTool)).toBeNull();
		expect(coerceAntmlParameters([{ name: "items", rawValue: "{bad" }], arrayTool)).toBeNull();
	});

	it("rejects missing required parameters at the validation boundary", () => {
		// given
		const tool = createTool(Type.Object({ command: Type.String() }));

		// when / then
		expect(coerceAntmlParameters([], tool)).toBeNull();
	});

	it("keeps schema-typed additional properties instead of filtering them", () => {
		// given
		const tool = createTool(Type.Object({ known: Type.String() }, { additionalProperties: Type.String() }));

		// when
		const result = coerceAntmlParameters(
			[
				{ name: "known", rawValue: "ok" },
				{ name: "extra", rawValue: "kept" },
			],
			tool,
		);

		// then
		expect(result).toEqual({ known: "ok", extra: "kept" });
	});

	it("drops a __proto__ parameter without polluting prototypes", () => {
		// given
		const tool = createTool(Type.Object({ command: Type.String() }));

		// when
		const result = coerceAntmlParameters(
			[
				{ name: "command", rawValue: "echo safe" },
				{ name: "__proto__", rawValue: '{"polluted":true}' },
			],
			tool,
		);

		// then
		expect(result).toEqual({ command: "echo safe" });
		expect({} as { polluted?: boolean }).not.toHaveProperty("polluted");
	});
});
