import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { prepareAgentToolCallArguments } from "../src/agent-loop.ts";
import type { AgentTool, AgentToolCall } from "../src/types.ts";

const PARAMETERS = Type.Object({
	summary: Type.Optional(Type.String()),
	nested: Type.Optional(Type.Object({ value: Type.String() })),
});

// Copies the two real in-place shims instead of inventing one, because the test is only
// evidence if the fixture behaves like production: eval-tool.ts assigns and deletes
// `record.summary`, and harness/tools/edit.ts assigns `args.edits`. Both return the
// same reference they were handed.
function inPlaceNormalizingTool(): AgentTool {
	return {
		name: "in_place_normalizer",
		label: "In-place normalizer",
		description: "Normalizes its arguments in place and returns the same reference.",
		parameters: PARAMETERS,
		prepareArguments: (args) => {
			const record = args as { summary?: string; nested?: { value: string } };
			if (typeof record.summary === "string") record.summary = record.summary.slice(0, 3);
			if (record.nested !== undefined) record.nested.value = "normalized";
			return record;
		},
		execute: () => Promise.resolve({ content: [{ type: "text" as const, text: "" }], details: undefined }),
	};
}

function keyDeletingTool(): AgentTool {
	return {
		...inPlaceNormalizingTool(),
		prepareArguments: (args) => {
			const record = args as { summary?: string };
			delete record.summary;
			return record;
		},
	};
}

function toolCallWith(args: AgentToolCall["arguments"]): AgentToolCall {
	return { type: "toolCall", id: "call-1", name: "in_place_normalizer", arguments: args };
}

describe("tool-argument preparation cannot rewrite the assistant tool call", () => {
	it("keeps the provider's arguments when the shim normalizes in place", () => {
		const toolCall = toolCallWith({ summary: "original summary", nested: { value: "original" } });

		const prepared = prepareAgentToolCallArguments(inPlaceNormalizingTool(), toolCall);

		expect(toolCall.arguments).toEqual({ summary: "original summary", nested: { value: "original" } });
		expect(prepared.arguments).toEqual({ summary: "ori", nested: { value: "normalized" } });
	});

	it("keeps the provider's arguments when the shim deletes a key", () => {
		const toolCall = toolCallWith({ summary: "original summary" });

		const prepared = prepareAgentToolCallArguments(keyDeletingTool(), toolCall);

		expect(toolCall.arguments).toEqual({ summary: "original summary" });
		expect(prepared.arguments).toEqual({});
	});

	it("keeps nested provider arguments when the shim mutates a nested object", () => {
		const nested = { value: "original" };
		const toolCall = toolCallWith({ nested });

		prepareAgentToolCallArguments(inPlaceNormalizingTool(), toolCall);

		expect(nested.value).toBe("original");
	});

	it("leaves a tool without a shim on its original arguments object", () => {
		const toolCall = toolCallWith({ summary: "original summary" });
		const { prepareArguments: _omitted, ...withoutShim } = inPlaceNormalizingTool();

		const prepared = prepareAgentToolCallArguments(withoutShim, toolCall);

		expect(prepared).toBe(toolCall);
		expect(prepared.arguments).toBe(toolCall.arguments);
	});
});
