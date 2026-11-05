import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import type { JsonValue, Tool, ToolCall } from "../src/types.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

function createToolCallWithPlainSchema(
	schema: Tool["parameters"],
	value: unknown,
): {
	tool: Tool;
	toolCall: ToolCall;
} {
	const tool: Tool = {
		name: "echo",
		description: "Echo tool",
		parameters: {
			type: "object",
			properties: {
				value: schema,
			},
			required: ["value"],
		} as Tool["parameters"],
	};

	const toolCall: ToolCall = {
		type: "toolCall",
		id: "tool-1",
		name: "echo",
		arguments: { value: value as JsonValue },
	};

	return { tool, toolCall };
}

describe("validateToolArguments", () => {
	it("still validates when Function constructor is unavailable", () => {
		const originalFunction = globalThis.Function;
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				count: Type.Number(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { count: "42" as unknown as number },
		};

		globalThis.Function = (() => {
			throw new EvalError("Code generation from strings disallowed for this context");
		}) as unknown as FunctionConstructor;

		try {
			expect(validateToolArguments(tool, toolCall)).toEqual({ count: 42 });
		} finally {
			globalThis.Function = originalFunction;
		}
	});

	it("coerces serialized plain JSON schemas with AJV-compatible primitive rules", () => {
		const passingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
			expected: unknown;
		}> = [
			{ schema: { type: "number" } as Tool["parameters"], input: "42", expected: 42 },
			{ schema: { type: "number" } as Tool["parameters"], input: true, expected: 1 },
			{ schema: { type: "number" } as Tool["parameters"], input: null, expected: 0 },
			{ schema: { type: "integer" } as Tool["parameters"], input: "42", expected: 42 },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "true", expected: true },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "false", expected: false },
			{ schema: { type: "boolean" } as Tool["parameters"], input: 1, expected: true },
			{ schema: { type: "boolean" } as Tool["parameters"], input: 0, expected: false },
			{ schema: { type: "string" } as Tool["parameters"], input: null, expected: "" },
			{ schema: { type: "string" } as Tool["parameters"], input: true, expected: "true" },
			{ schema: { type: "null" } as Tool["parameters"], input: "", expected: null },
			{ schema: { type: "null" } as Tool["parameters"], input: 0, expected: null },
			{ schema: { type: "null" } as Tool["parameters"], input: false, expected: null },
			{
				schema: { type: ["number", "string"] } as Tool["parameters"],
				input: "1",
				expected: "1",
			},
			{
				schema: { type: ["boolean", "number"] } as Tool["parameters"],
				input: "1",
				expected: 1,
			},
		];

		for (const testCase of passingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(validateToolArguments(tool, toolCall)).toEqual({ value: testCase.expected });
		}
	});

	it("treats null as omission for optional non-nullable properties", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				path: Type.String(),
				offset: Type.Optional(Type.Number()),
				nullable: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				metadata: Type.Object({ enabled: Type.Optional(Type.Boolean()) }),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { path: "file.txt", offset: null, nullable: null, metadata: { enabled: null } },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({
			path: "file.txt",
			nullable: null,
			metadata: {},
		});
	});

	it("preserves optional nulls whose referenced schema is nullable", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: {
				type: "object",
				properties: { value: { $ref: "#/$defs/value" } },
				$defs: { value: { anyOf: [{ type: "number" }, { type: "null" }] } },
			} as Tool["parameters"],
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { value: null },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	it("preserves a value that already matches a nullable union arm", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				value: Type.Union([Type.Number(), Type.Null()]),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { value: null },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	it("preserves a value that already matches a oneOf nullable union arm", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema(
			{ oneOf: [{ type: "number" }, { type: "null" }] } as Tool["parameters"],
			null,
		);

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	it("still coerces nullable unions when the original value does not match any arm", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema(
			{ anyOf: [{ type: "number" }, { type: "null" }] } as Tool["parameters"],
			"42",
		);

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: 42 });
	});

	it("accepts null for nullable array schemas with items", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema(
			{ type: ["array", "null"], items: { type: "string" } } as Tool["parameters"],
			null,
		);
		// The CSP test above selects TypeBox's process-wide interpreted fallback, so exercise the generated validator explicitly.
		const generatedCheck = new Function(Compile(tool.parameters).Code())() as (value: unknown) => boolean;

		expect(generatedCheck(toolCall.arguments)).toBe(true);
		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	it("rejects invalid coercions for serialized plain JSON schemas", () => {
		const failingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
		}> = [
			{ schema: { type: "boolean" } as Tool["parameters"], input: "1" },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "0" },
			{ schema: { type: "null" } as Tool["parameters"], input: "null" },
			{ schema: { type: "integer" } as Tool["parameters"], input: "42.1" },
		];

		for (const testCase of failingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
		}
	});
});

describe("validateToolArguments discriminated unions (#5141)", () => {
	const runProperties = {
		action: Type.Optional(
			Type.Union([Type.Literal("run"), Type.Literal("list"), Type.Literal("peek"), Type.Literal("stop")]),
		),
		language: Type.Optional(Type.Union([Type.Literal("js"), Type.Literal("py")])),
		code: Type.Optional(Type.String()),
		summary: Type.Optional(Type.String()),
		timeout: Type.Optional(Type.Number({ minimum: 1 })),
		cell_id: Type.Optional(Type.String({ minLength: 1 })),
	};
	const unionTool: Tool = {
		name: "runner",
		description: "Discriminated union tool",
		parameters: Type.Unsafe(
			Type.Object(runProperties, {
				anyOf: [
					Type.Object(
						{ ...runProperties, action: Type.Optional(Type.Literal("run")) },
						{ required: ["language", "code", "summary"] },
					),
					Type.Object({ action: Type.Literal("list") }),
					Type.Object(
						{ action: Type.Union([Type.Literal("peek"), Type.Literal("stop")]), cell_id: runProperties.cell_id },
						{ required: ["action", "cell_id"] },
					),
				],
			}),
		),
	};

	function errorLines(tool: Tool, args: Record<string, JsonValue>): string[] {
		const toolCall: ToolCall = { type: "toolCall", id: "tool-1", name: tool.name, arguments: args };
		try {
			validateToolArguments(tool, toolCall);
		} catch (error) {
			const message = (error as Error).message;
			return (
				message
					.split("\n\nReceived arguments:")[0]
					?.split("\n")
					.filter((line) => line.startsWith("  - ")) ?? []
			);
		}
		throw new Error("expected validation to fail");
	}

	it("reports only the default branch when the discriminator is omitted", () => {
		const lines = errorLines(unionTool, { code: "1", summary: "s" });
		expect(lines).toEqual([
			'  - for action "run" (default when action is omitted): language: must have required properties language',
		]);
	});

	it("reports only the selected branch when the discriminator is given", () => {
		expect(errorLines(unionTool, { action: "peek" })).toEqual([
			'  - for action "peek": cell_id: must have required properties cell_id',
		]);
		expect(errorLines(unionTool, { action: "list", timeout: "soon" })).toEqual([
			'  - for action "list": timeout: must be number',
		]);
	});

	it("names the allowed values for an unknown discriminator value", () => {
		expect(errorLines(unionTool, { action: "peak", cell_id: "x" })).toEqual([
			'  - action: must be one of "run", "list", "peek", "stop" (received "peak")',
		]);
	});

	it("keeps the full error list for a union without a const discriminator", () => {
		const tool: Tool = {
			name: "plain",
			description: "Plain union tool",
			parameters: Type.Unsafe(
				Type.Object(
					{ a: Type.Optional(Type.String()), b: Type.Optional(Type.String()) },
					{ anyOf: [Type.Object({ a: Type.String() }), Type.Object({ b: Type.String() })] },
				),
			),
		};
		expect(errorLines(tool, {})).toEqual([
			"  - a: must have required properties a",
			"  - b: must have required properties b",
			"  - root: must match a schema in anyOf",
		]);
	});
});
