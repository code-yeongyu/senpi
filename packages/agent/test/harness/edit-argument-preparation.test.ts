import type { JsonObject } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { prepareToolCall } from "../../src/harness/execution/tools.ts";
import { createEditTool } from "../../src/harness/tools/edit.ts";
import type { ExecutionToolContext } from "../../src/harness/tools/tool-context.ts";
import type { AgentHarnessTool } from "../../src/harness/types.ts";
import type { AgentToolCall } from "../../src/types.ts";

const tools: AgentHarnessTool<ExecutionToolContext>[] = [createEditTool()];

function editCall(arguments_: JsonObject): AgentToolCall {
	return { type: "toolCall", id: "edit-legacy", name: "edit", arguments: arguments_ };
}

function prepare(call: AgentToolCall) {
	return prepareToolCall(call, tools);
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

describe("edit argument preparation", () => {
	it("normalizes edits sent as a JSON string without rewriting the provider call", () => {
		const call = editCall({ path: "a.txt", edits: JSON.stringify([{ oldText: "a", newText: "b" }]) });
		const before = structuredClone(call.arguments);

		const prepared = prepare(call);

		expect("kind" in prepared).toBe(false);
		if ("kind" in prepared) return;
		expect(prepared.args).toEqual({ path: "a.txt", edits: [{ oldText: "a", newText: "b" }] });
		expect(call.arguments).toEqual(before);
	});

	it("normalizes a single edit object without rewriting the provider call", () => {
		const call = editCall({ path: "a.txt", edits: { oldText: "a", newText: "b" } });
		const before = structuredClone(call.arguments);

		const prepared = prepare(call);

		expect("kind" in prepared).toBe(false);
		if ("kind" in prepared) return;
		expect(prepared.args).toEqual({ path: "a.txt", edits: [{ oldText: "a", newText: "b" }] });
		expect(call.arguments).toEqual(before);
	});

	it("normalizes legacy shapes held in frozen provider arguments", () => {
		const fromString = prepare(
			deepFreeze(editCall({ path: "a.txt", edits: JSON.stringify({ oldText: "a", newText: "b" }) })),
		);
		const fromObject = prepare(deepFreeze(editCall({ path: "a.txt", edits: { oldText: "a", newText: "b" } })));

		for (const prepared of [fromString, fromObject]) {
			expect("kind" in prepared ? prepared.result.content : prepared.args).toEqual({
				path: "a.txt",
				edits: [{ oldText: "a", newText: "b" }],
			});
		}
	});

	it("rejects array arguments with a validation error", () => {
		const call = { ...editCall({}), arguments: [{ oldText: "a", newText: "b" }] as unknown as JsonObject };

		const prepared = prepare(call);

		expect("kind" in prepared && prepared.isError).toBe(true);
		if (!("kind" in prepared)) return;
		const message = prepared.result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		expect(message).toContain('Validation failed for tool "edit"');
	});
});
