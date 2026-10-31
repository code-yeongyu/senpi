// MCP elicitation form mode (todo 41): capability declared empty; the form
// walks flat primitives through ui.input/select; unavailable UI and invalid
// answers are processing errors; dismissed dialogs and bounded timeouts cancel.

import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
	MCP_CLIENT_ELICITATION_CAPABILITY,
	runElicitationForm,
} from "../../src/core/extensions/builtin/mcp/elicitation.ts";

const SCHEMA = {
	properties: {
		confirmed: { type: "boolean" },
		count: { type: "integer" },
		mode: { enum: ["alpha", "beta"], type: "string" },
		name: { type: "string" },
	},
	required: ["name"],
};

function scriptedUi(overrides: Partial<Record<"input" | "select" | "confirm", unknown>> = {}) {
	return {
		confirm: async () => true,
		input: async (title: string) => (title.includes("count") ? "42" : "Ada"),
		select: async (title: string) => (title.includes("confirmed") ? "Yes" : "beta"),
		...overrides,
	} as never;
}

describe("mcp elicitation form", () => {
	it("declares the capability as an empty object", () => {
		expect(MCP_CLIENT_ELICITATION_CAPABILITY).toEqual({ elicitation: {} });
	});

	it("cancels an automated task parent's dialog without fabricating boolean values", async () => {
		const response = await runElicitationForm(
			scriptedUi({ confirm: async () => false, select: async () => undefined }),
			"Server asks",
			{ properties: { confirmed: { type: "boolean" } }, required: ["confirmed"] },
		);
		expect(response).toEqual({ action: "cancel" });
	});

	it.each([
		["Yes", true],
		["No", false],
		[" yes ", true],
		["y", true],
		["true", true],
		[" NO ", false],
		["n", false],
		["false", false],
	] as const)("accepts an explicit human %s as boolean %s", async (answer, expected) => {
		const response = await runElicitationForm(scriptedUi({ select: async () => answer }), "Server asks", {
			properties: { confirmed: { type: "boolean" } },
			required: ["confirmed"],
		});
		expect(response).toEqual({ action: "accept", content: { confirmed: expected } });
	});

	it("rejects an unrecognized boolean selection without field values", async () => {
		await expect(
			runElicitationForm(scriptedUi({ select: async () => "not an answer" }), "Server asks", {
				properties: { confirmed: { type: "boolean" } },
			}),
		).rejects.toMatchObject({ code: ErrorCode.InternalError, data: undefined });
	});

	it.each<Parameters<typeof runElicitationForm>[2]>([
		{ properties: { name: { type: "string" } } },
		{ properties: {} },
	])("cancels a dismissed dialog even without required fields: %j", async (schema) => {
		const response = await runElicitationForm(
			scriptedUi({ input: async () => undefined, select: async () => undefined }),
			"Server asks",
			schema,
		);
		expect(response).toEqual({ action: "cancel" });
	});

	it("cancels a dismissed enum dialog without returning earlier field values", async () => {
		expect(
			await runElicitationForm(scriptedUi({ select: async () => undefined }), "Ask", {
				properties: { name: { type: "string" }, mode: { type: "string", enum: ["alpha", "beta"] } },
			}),
		).toEqual({ action: "cancel" });
	});

	it("accepts a human's explicit submission of a form with no field values", async () => {
		const response = await runElicitationForm(scriptedUi({ select: async () => "Submit" }), "Server asks", {
			properties: {},
		});
		expect(response).toEqual({ action: "accept", content: {} });
	});

	it("accepts with typed values from scripted ui answers", async () => {
		const response = await runElicitationForm(scriptedUi(), "Server asks", SCHEMA);
		expect(response).toEqual({
			action: "accept",
			content: { confirmed: true, count: 42, mode: "beta", name: "Ada" },
		});
	});

	it("cancels when a required dialog is dismissed and rejects invalid numbers", async () => {
		const missing = await runElicitationForm(scriptedUi({ input: async () => undefined }), "Ask", SCHEMA);
		expect(missing).toEqual({ action: "cancel" });

		await expect(
			runElicitationForm(
				scriptedUi({ input: async (title: string) => (title.includes("count") ? "not-a-number" : "Ada") }),
				"Ask",
				SCHEMA,
			),
		).rejects.toMatchObject({ code: ErrorCode.InternalError, data: undefined });
	});

	it("rejects an empty required answer rather than fabricating a refusal", async () => {
		await expect(
			runElicitationForm(scriptedUi({ input: async () => "" }), "Ask", {
				properties: { name: { type: "string" } },
				required: ["name"],
			}),
		).rejects.toMatchObject({ code: ErrorCode.InternalError, data: undefined });
	});

	it("cancels via the bounded timeout without wedging", async () => {
		vi.useFakeTimers();
		try {
			const hangingUi = scriptedUi({ input: () => new Promise(() => undefined) });
			const response = runElicitationForm(hangingUi, "Ask", SCHEMA, 50);
			await vi.advanceTimersByTimeAsync(50);
			expect(await response).toEqual({ action: "cancel" });
		} finally {
			vi.useRealTimers();
		}
	});
});
