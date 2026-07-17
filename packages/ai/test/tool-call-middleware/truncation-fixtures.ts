import { Type } from "typebox";
import type { Tool } from "../../src/types.ts";

export type TruncationFixture = {
	title: string;
	input: string;
	tool: "get_weather" | "todowrite" | "get_location";
	expected:
		| { kind: "recovered"; arguments: Record<string, unknown> }
		| { kind: "incomplete" }
		| { kind: "dropped" }
		| { kind: "text" };
};

export const FIXTURE_TOOLS: Tool[] = [
	{
		name: "get_weather",
		description: "Get weather",
		parameters: Type.Object({
			city: Type.String(),
			days: Type.Optional(Type.Integer()),
		}),
	},
	{
		name: "todowrite",
		description: "Write todos",
		parameters: Type.Object({
			todos: Type.Array(
				Type.Object({
					content: Type.String(),
					status: Type.String(),
					priority: Type.String(),
				}),
				{ minItems: 1 },
			),
		}),
	},
	{
		name: "get_location",
		description: "Get location",
		parameters: Type.Object({}),
	},
];

export const TRUNCATION_FIXTURES: Record<
	"anthropic-xml" | "hermes" | "yaml-xml" | "morph-xml" | "gemma4-delimiter",
	TruncationFixture[]
> = {
	"anthropic-xml": [
		{
			title: "R3/R4-pass: closed parameter with only invoke close missing",
			input: '<invoke name="get_weather"><parameter name="city">Seoul</parameter>',
			tool: "get_weather",
			expected: { kind: "recovered", arguments: { city: "Seoul" } },
		},
		{
			title: "R3/R4-pass: proper invoke-close prefix after complete parameters",
			input: '<invoke name="get_weather"><parameter name="city">Seoul</parameter></inv',
			tool: "get_weather",
			expected: { kind: "recovered", arguments: { city: "Seoul" } },
		},
		{
			title: "R3-fail: mid-value cut leaves parameter unclosed",
			input: '<invoke name="get_weather"><parameter name="city">Seo',
			tool: "get_weather",
			expected: { kind: "incomplete" },
		},
		{
			title: "R4-fail: closed parameters violate todowrite minItems",
			input: '<invoke name="todowrite"><parameter name="todos">[]</parameter>',
			tool: "todowrite",
			expected: { kind: "incomplete" },
		},
		{
			title: "R1-fail: nameless invoke prefix is dropped",
			input: "<invoke na",
			tool: "get_weather",
			expected: { kind: "dropped" },
		},
		{
			title: "R2-fail: unknown invoke remains ordinary text",
			input: '<invoke name="unknown_tool"><parameter name="city">Seoul</parameter>',
			tool: "get_weather",
			expected: { kind: "text" },
		},
	],
	hermes: [
		{
			title: "R3/R4-pass: complete JSON object with terminator missing",
			input: '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}',
			tool: "get_weather",
			expected: { kind: "recovered", arguments: { city: "Seoul" } },
		},
		{
			title: "R3/R4-pass: complete JSON object with terminator prefix",
			input: '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</tool_',
			tool: "get_weather",
			expected: { kind: "recovered", arguments: { city: "Seoul" } },
		},
		{
			title: "R3-fail: mid-value JSON cut is incomplete",
			input: '<tool_call>{"name":"get_weather","arguments":{"city":"Seo',
			tool: "get_weather",
			expected: { kind: "incomplete" },
		},
		{
			title: "R4-fail: complete JSON violates todowrite minItems",
			input: '<tool_call>{"name":"todowrite","arguments":{"todos":[]}}',
			tool: "todowrite",
			expected: { kind: "incomplete" },
		},
		{
			title: "Nameless/R2-fail: JSON tool-call fragment has no resolvable name",
			input: '<tool_call>{"na',
			tool: "get_weather",
			expected: { kind: "dropped" },
		},
	],
	"gemma4-delimiter": [
		{
			title: "R3/R4-pass: balanced arguments with terminator missing",
			input: '<|tool_call>call:get_weather{city:<|"|>Seoul<|"|>}',
			tool: "get_weather",
			expected: { kind: "recovered", arguments: { city: "Seoul" } },
		},
		{
			title: "R3-fail: unbalanced argument object is incomplete",
			input: '<|tool_call>call:get_weather{city:<|"|>Seoul<|"|>',
			tool: "get_weather",
			expected: { kind: "incomplete" },
		},
		{
			title: "R4-fail: balanced arguments violate todowrite minItems",
			input: "<|tool_call>call:todowrite{todos:[]}",
			tool: "todowrite",
			expected: { kind: "incomplete" },
		},
		{
			title: "R1-fail: nameless call prefix is dropped",
			input: "<|tool_call>call:",
			tool: "get_weather",
			expected: { kind: "dropped" },
		},
		{
			title: "R2-fail: unknown Gemma tool is dropped",
			input: '<|tool_call>call:unknown_tool{city:<|"|>Seoul<|"|>}',
			tool: "get_weather",
			expected: { kind: "dropped" },
		},
	],
	"morph-xml": [
		{
			title: "R3/R4-pass: closed child with only tool close missing",
			input: "<get_weather><city>NY</city>",
			tool: "get_weather",
			expected: { kind: "recovered", arguments: { city: "NY" } },
		},
		{
			title: "R3-fail: unclosed child makes XML argument body unparseable",
			input: "<get_weather><city>NY</city><days>",
			tool: "get_weather",
			expected: { kind: "incomplete" },
		},
		{
			title: "R4-fail: parseable empty todos array violates minItems",
			input: "<todowrite><todos></todos>",
			tool: "todowrite",
			expected: { kind: "incomplete" },
		},
		{
			title: "R2-fail: unknown XML tag remains ordinary text",
			input: "<unknown_tool><city>Seoul</city>",
			tool: "get_weather",
			expected: { kind: "text" },
		},
	],
	"yaml-xml": [
		{
			title: "R3/R4-pass: parseable YAML mapping with closing tag missing",
			input: "<get_weather>\ncity: Seoul",
			tool: "get_weather",
			expected: { kind: "recovered", arguments: { city: "Seoul" } },
		},
		{
			title: "R3/R4-pass: empty YAML body validates empty get_location arguments",
			input: "<get_location>\n",
			tool: "get_location",
			expected: { kind: "recovered", arguments: {} },
		},
		{
			title: "R3-fail: invalid YAML mapping is incomplete",
			input: "<get_weather>\n[invalid: yaml:",
			tool: "get_weather",
			expected: { kind: "incomplete" },
		},
		{
			title: "R4-fail: parseable YAML violates todowrite minItems",
			input: "<todowrite>\ntodos: []",
			tool: "todowrite",
			expected: { kind: "incomplete" },
		},
		{
			title: "R2-fail: unknown YAML XML tag remains ordinary text",
			input: "<unknown_tool>\ncity: Seoul",
			tool: "get_weather",
			expected: { kind: "text" },
		},
	],
};
