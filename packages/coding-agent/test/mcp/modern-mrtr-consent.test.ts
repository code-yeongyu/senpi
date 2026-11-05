import { describe, expect, it, vi } from "vitest";
import { collectMrtrForm } from "../../src/core/extensions/builtin/mcp/modern/elicitation.ts";
import { validateMrtrForm } from "../../src/core/extensions/builtin/mcp/modern/form-schema.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";

function runElicitationForm(
	ui: Pick<ExtensionUIContext, "select" | "input" | "confirm">,
	message: string,
	schema: unknown,
) {
	return collectMrtrForm(
		{ ui, signal: new AbortController().signal },
		"fixture",
		{ message, requestedSchema: { type: "object", ...(schema as object) } },
		new AbortController().signal,
	);
}

describe("private MRTR consent", () => {
	it.each(["2026-02-30T12:00:00Z", "2026-10-24T24:00:00Z"])("rejects invalid calendar defaults (%s)", (value) => {
		expect(
			validateMrtrForm({
				type: "object",
				properties: { value: { type: "string", format: "date-time", default: value } },
			}),
		).toBe(false);
	});
	it("empty forms still require explicit submission", async () => {
		const select = vi.fn().mockResolvedValue(undefined);
		const result = await runElicitationForm({ select, input: vi.fn(), confirm: vi.fn() }, "question", {
			properties: {},
		});
		expect(result).toEqual({ action: "cancel" });
		expect(select).toHaveBeenCalled();
	});
	it("false is data and boolean confirmation is never used", async () => {
		const confirm = vi.fn().mockResolvedValue(false);
		const select = vi
			.fn()
			.mockResolvedValueOnce("Continue")
			.mockResolvedValueOnce("false")
			.mockResolvedValueOnce("Submit");
		const result = await runElicitationForm({ select, input: vi.fn(), confirm }, "question", {
			properties: { flag: { type: "boolean" } },
			required: ["flag"],
		});
		expect(result).toEqual({ action: "accept", content: { flag: false } });
		expect(confirm).not.toHaveBeenCalled();
	});
	it("explicit decline has no content and collects no fields", async () => {
		const input = vi.fn().mockResolvedValue("private");
		const result = await runElicitationForm(
			{ select: vi.fn().mockResolvedValue("Decline"), input, confirm: vi.fn() },
			"question",
			{ properties: { text: { type: "string" } } },
		);
		expect(result).toEqual({ action: "decline" });
		expect(input).not.toHaveBeenCalled();
	});
	it("dismissal cancels without returning partial draft content", async () => {
		const result = await runElicitationForm(
			{
				select: vi.fn().mockResolvedValue("Continue"),
				input: vi.fn().mockResolvedValue(undefined),
				confirm: vi.fn(),
			},
			"question",
			{ properties: { text: { type: "string" } }, required: ["text"] },
		);
		expect(result).toEqual({ action: "cancel" });
	});
	it.each([
		{ type: "object", properties: { value: { type: "object" } } },
		{ type: "object", properties: { value: { type: "string", pattern: ".*" } } },
		{ type: "object", properties: { value: { type: "string", format: "unknown" } } },
		{ type: "object", properties: { value: { type: "integer", minimum: 10, maximum: 1 } } },
		{ type: "object", properties: { value: { type: "boolean", default: "false" } } },
		{ type: "object", properties: { value: { type: "array", items: { type: "object" } } } },
	])("unsupported or invalid schemas are rejected rather than weakened", (schema) => {
		expect(validateMrtrForm(schema)).toBe(false);
	});
	it.each([
		[{ type: "string" }, "", ""],
		[{ type: "integer", minimum: 0, maximum: 100 }, "42", 42],
		[{ type: "number", minimum: 0, maximum: 1 }, "0.5", 0.5],
		[{ type: "string", format: "email" }, "test@example.test", "test@example.test"],
		[{ type: "string", format: "date" }, "2026-10-24", "2026-10-24"],
		[{ type: "string", format: "date-time" }, "2026-10-24T12:00:00Z", "2026-10-24T12:00:00Z"],
	])("submitted primitive values retain their type", async (property, answer, expected) => {
		const select = vi.fn(async (_title: string, choices: string[]) =>
			choices.includes("Submit") ? "Submit" : choices[0],
		);
		const result = await runElicitationForm(
			{ select, input: vi.fn().mockResolvedValue(answer), confirm: vi.fn() },
			"question",
			{ properties: { value: property }, required: ["value"] },
		);
		expect(result).toEqual({ action: "accept", content: { value: expected } });
	});
	it("optional unset and explicit defaults differ from empty strings", async () => {
		const select = vi
			.fn()
			.mockResolvedValueOnce("Continue")
			.mockResolvedValueOnce("Leave unset")
			.mockResolvedValueOnce("Use default")
			.mockResolvedValueOnce("Submit");
		const result = await runElicitationForm({ select, input: vi.fn(), confirm: vi.fn() }, "question", {
			properties: { absent: { type: "string" }, flag: { type: "boolean", default: false } },
		});
		expect(result).toEqual({ action: "accept", content: { flag: false } });
	});
	it("review permits editing and titled enums send constants not labels", async () => {
		const select = vi
			.fn()
			.mockResolvedValueOnce("Continue")
			.mockResolvedValueOnce("1. Red")
			.mockResolvedValueOnce("Edit field")
			.mockResolvedValueOnce("1. color")
			.mockResolvedValueOnce("2. Green")
			.mockResolvedValueOnce("Submit");
		const result = await runElicitationForm({ select, input: vi.fn(), confirm: vi.fn() }, "question", {
			properties: {
				color: {
					type: "string",
					oneOf: [
						{ const: "#f00", title: "Red" },
						{ const: "#0f0", title: "Green" },
					],
				},
			},
			required: ["color"],
		});
		expect(result).toEqual({ action: "accept", content: { color: "#0f0" } });
	});
	it("enum arrays enforce item bounds and return selected values", async () => {
		const select = vi
			.fn()
			.mockResolvedValueOnce("Continue")
			.mockResolvedValueOnce("Done")
			.mockResolvedValueOnce("Try again")
			.mockResolvedValueOnce("1. Red")
			.mockResolvedValueOnce("Done")
			.mockResolvedValueOnce("Submit");
		const result = await runElicitationForm({ select, input: vi.fn(), confirm: vi.fn() }, "question", {
			properties: {
				colors: { type: "array", minItems: 1, maxItems: 2, items: { anyOf: [{ const: "#f00", title: "Red" }] } },
			},
			required: ["colors"],
		});
		expect(result).toEqual({ action: "accept", content: { colors: ["#f00"] } });
	});
	it("invalid field values require re-entry and cannot submit partial data", async () => {
		const select = vi
			.fn()
			.mockResolvedValueOnce("Continue")
			.mockResolvedValueOnce("Try again")
			.mockResolvedValueOnce("Submit");
		const input = vi.fn().mockResolvedValueOnce("2.5").mockResolvedValueOnce("3");
		const result = await runElicitationForm({ select, input, confirm: vi.fn() }, "question", {
			properties: { value: { type: "integer", minimum: 0, maximum: 5 } },
			required: ["value"],
		});
		expect(result).toEqual({ action: "accept", content: { value: 3 } });
		expect(input).toHaveBeenCalledTimes(2);
	});
});
