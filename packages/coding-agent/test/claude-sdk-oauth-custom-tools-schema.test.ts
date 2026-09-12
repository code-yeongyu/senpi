import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { denyCustomToolExecution } from "../src/core/extensions/builtin/claude-sdk-oauth/custom-tools.ts";
import { jsonSchemaToZodShape } from "../src/core/extensions/builtin/claude-sdk-oauth/custom-tools-schema.ts";
import { TOOL_EXECUTION_DENIED_MESSAGE } from "../src/core/extensions/builtin/claude-sdk-oauth/tools.ts";

describe("jsonSchemaToZodShape", () => {
	it("converts TypeBox-style object schemas with required/optional fields", () => {
		const shape = jsonSchemaToZodShape({
			type: "object",
			properties: {
				path: { type: "string" },
				count: { type: "integer" },
				verbose: { type: "boolean" },
				mode: { enum: ["fast", "slow"] },
				tags: { type: "array", items: { type: "string" } },
			},
			required: ["path", "count"],
		});
		const object = z.object(shape);
		expect(object.safeParse({ path: "a", count: 2 }).success).toBe(true);
		expect(object.safeParse({ count: 2 }).success).toBe(false);
		expect(object.safeParse({ path: "a", count: 2, mode: "fast", tags: ["x"] }).success).toBe(true);
		expect(object.safeParse({ path: "a", count: 2, mode: "other" }).success).toBe(false);
		expect(object.safeParse({ path: "a", count: 2, verbose: true }).success).toBe(true);
	});

	it("converts real TypeBox literal unions and const values", () => {
		const schema = Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("status")]),
			mode: Type.Literal("safe"),
			note: Type.Optional(Type.String()),
		});
		const object = z.object(jsonSchemaToZodShape(schema));
		expect(object.safeParse({ action: "start", mode: "safe" }).success).toBe(true);
		expect(object.safeParse({ action: "delete", mode: "safe" }).success).toBe(false);
		expect(object.safeParse({ action: "stop", mode: "yolo" }).success).toBe(false);
	});

	it("produces an empty shape for missing properties", () => {
		expect(jsonSchemaToZodShape(undefined)).toEqual({});
		expect(jsonSchemaToZodShape({ type: "object" })).toEqual({});
	});
});

describe("custom tool advertisement", () => {
	it("deny handler always refuses execution with the denial message", async () => {
		const result = await denyCustomToolExecution();
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe(TOOL_EXECUTION_DENIED_MESSAGE);
		expect(result.content[0]?.text).toContain("not a failure");
	});
});
