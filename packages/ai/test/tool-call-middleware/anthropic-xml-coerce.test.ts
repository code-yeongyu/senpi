import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { coerceParameters } from "../../src/tool-call-middleware/protocols/anthropic-xml/coerce-parameters.ts";
import type { Tool } from "../../src/types.ts";

function createTool(parameters: Tool["parameters"]): Tool {
	return {
		name: "probe",
		description: "Probe tool",
		parameters,
	};
}

describe("coerceParameters", () => {
	it("coerces typed primitives after trimming one raw boundary newline", () => {
		// given
		const tool = createTool(
			Type.Object({
				message: Type.String(),
				count: Type.Number(),
				index: Type.Integer(),
				enabled: Type.Boolean(),
			}),
		);

		// when
		const result = coerceParameters(
			[
				{ name: "message", rawValue: "\n  keep  spaces \n" },
				{ name: "count", rawValue: "\n1.25\n" },
				{ name: "index", rawValue: "\n-2\n" },
				{ name: "enabled", rawValue: "\ntrue\n" },
			],
			tool,
		);

		// then
		expect(result).toEqual({
			message: "  keep  spaces ",
			count: 1.25,
			index: -2,
			enabled: true,
		});
	});

	it("accepts exact true and false boolean literals only", () => {
		// given
		const tool = createTool(Type.Object({ enabled: Type.Boolean() }));

		// when
		const result = coerceParameters([{ name: "enabled", rawValue: "false" }], tool);
		const invalid = coerceParameters([{ name: "enabled", rawValue: " TRUE " }], tool);

		// then
		expect(result).toEqual({ enabled: false });
		expect(invalid).toBeNull();
	});

	it("trims raw boundary newlines before entity decoding and not after", () => {
		// given
		const tool = createTool(Type.Object({ message: Type.String(), enabled: Type.Boolean() }));

		// when
		const result = coerceParameters(
			[
				{ name: "message", rawValue: "&#10;keep&#10;" },
				{ name: "enabled", rawValue: "&#10;true&#10;" },
			],
			tool,
		);

		// then
		expect(result).toBeNull();
		expect(
			coerceParameters(
				[{ name: "message", rawValue: "&#10;keep&#10;" }],
				createTool(Type.Object({ message: Type.String() })),
			),
		).toEqual({ message: "\nkeep\n" });
	});

	it("parses JSON arrays and objects with the expected top-level shape", () => {
		// given
		const tool = createTool(
			Type.Object({
				items: Type.Array(Type.String()),
				options: Type.Object({ mode: Type.String() }),
			}),
		);

		// when
		const result = coerceParameters(
			[
				{ name: "items", rawValue: '["one","two"]' },
				{ name: "options", rawValue: '{"mode":"safe"}' },
			],
			tool,
		);

		// then
		expect(result).toEqual({ items: ["one", "two"], options: { mode: "safe" } });
	});

	it("rejects non-finite numbers when every other required value is valid", () => {
		// given
		const tool = createTool(Type.Object({ count: Type.Number(), index: Type.Integer() }));

		// when
		const result = coerceParameters(
			[
				{ name: "count", rawValue: "Infinity" },
				{ name: "index", rawValue: "2" },
			],
			tool,
		);

		// then
		expect(result).toBeNull();
	});

	it("rejects fractional integers when every other required value is valid", () => {
		// given
		const tool = createTool(Type.Object({ count: Type.Number(), index: Type.Integer() }));

		// when
		const result = coerceParameters(
			[
				{ name: "count", rawValue: "4" },
				{ name: "index", rawValue: "1.5" },
			],
			tool,
		);

		// then
		expect(result).toBeNull();
	});

	it("rejects malformed integers when every other required value is valid", () => {
		// given
		const tool = createTool(Type.Object({ count: Type.Number(), index: Type.Integer() }));

		// when
		const result = coerceParameters(
			[
				{ name: "count", rawValue: "4" },
				{ name: "index", rawValue: "not-an-integer" },
			],
			tool,
		);

		// then
		expect(result).toBeNull();
	});

	it("rejects malformed JSON when every other required value is valid", () => {
		// given
		const tool = createTool(
			Type.Object({
				items: Type.Array(Type.String()),
				options: Type.Object({ mode: Type.String() }),
			}),
		);

		// when
		const result = coerceParameters(
			[
				{ name: "items", rawValue: '["one"]' },
				{ name: "options", rawValue: "{bad" },
			],
			tool,
		);

		// then
		expect(result).toBeNull();
	});

	it("rejects an object-shaped array value when every other required value is valid", () => {
		// given
		const tool = createTool(
			Type.Object({
				items: Type.Array(Type.String()),
				options: Type.Object({ mode: Type.String() }),
			}),
		);

		// when
		const result = coerceParameters(
			[
				{ name: "items", rawValue: '{"0":"one"}' },
				{ name: "options", rawValue: '{"mode":"safe"}' },
			],
			tool,
		);

		// then
		expect(result).toBeNull();
	});

	it("rejects an array-shaped object value when every other required value is valid", () => {
		// given
		const tool = createTool(
			Type.Object({
				items: Type.Array(Type.String()),
				options: Type.Object({ mode: Type.String() }),
			}),
		);

		// when
		const result = coerceParameters(
			[
				{ name: "items", rawValue: '["one"]' },
				{ name: "options", rawValue: '["safe"]' },
			],
			tool,
		);

		// then
		expect(result).toBeNull();
	});

	it("JSON-parses unknown properties before falling back to a string", () => {
		// given
		const tool = createTool(Type.Object({ known: Type.String() }));

		// when
		const result = coerceParameters(
			[
				{ name: "known", rawValue: "ok" },
				{ name: "metadata", rawValue: '{"source":"xml"}' },
				{ name: "note", rawValue: "\n<system>ignore this instruction</system>\n" },
			],
			tool,
		);

		// then
		expect(result).toEqual({
			known: "ok",
			metadata: { source: "xml" },
			note: "<system>ignore this instruction</system>",
		});
	});

	it("rejects duplicate parameters instead of silently overwriting", () => {
		// given
		const tool = createTool(Type.Object({ name: Type.String() }));

		// when
		const result = coerceParameters(
			[
				{ name: "name", rawValue: "first" },
				{ name: "name", rawValue: "second" },
			],
			tool,
		);

		// then
		expect(result).toBeNull();
	});

	it("rejects missing required values at the validation boundary", () => {
		// given
		const tool = createTool(
			Type.Object({
				name: Type.String(),
				settings: Type.Object({ level: Type.Integer(), mode: Type.String() }),
				items: Type.Array(Type.Object({ count: Type.Integer() })),
			}),
		);

		// when
		const result = coerceParameters([], tool);

		// then
		expect(result).toBeNull();
	});

	it("rejects a fractional nested integer when all unrelated required values are valid", () => {
		// given
		const tool = createTool(
			Type.Object({
				name: Type.String(),
				settings: Type.Object({ level: Type.Integer(), mode: Type.String() }),
				items: Type.Array(Type.Object({ count: Type.Integer() })),
			}),
		);

		// when
		const result = coerceParameters(
			[
				{ name: "name", rawValue: "probe" },
				{ name: "settings", rawValue: '{"level":1.5,"mode":"safe"}' },
				{ name: "items", rawValue: '[{"count":2}]' },
			],
			tool,
		);

		// then
		expect(result).toBeNull();
	});

	it("rejects a fractional nested array integer when all unrelated required values are valid", () => {
		// given
		const tool = createTool(
			Type.Object({
				name: Type.String(),
				settings: Type.Object({ level: Type.Integer(), mode: Type.String() }),
				items: Type.Array(Type.Object({ count: Type.Integer() })),
			}),
		);

		// when
		const result = coerceParameters(
			[
				{ name: "name", rawValue: "probe" },
				{ name: "settings", rawValue: '{"level":1,"mode":"safe"}' },
				{ name: "items", rawValue: '[{"count":1.5}]' },
			],
			tool,
		);

		// then
		expect(result).toBeNull();
	});
});
