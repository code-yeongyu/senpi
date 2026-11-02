import {
	assertConfigValue,
	ConfigValueSchema,
	isConfigReference,
	NonemptyConfigValueSchema,
} from "@earendil-works/pi-ai/utils/config-reference";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";

describe("shared reference object grammar (#3858)", () => {
	const schema = Compile(ConfigValueSchema);

	it.each([
		{ $file: "./key" },
		{ $env: "TOKEN_3858" },
		{ $concat: ["Bearer ", { $env: "TOKEN" }, { $file: "./key" }] },
	])("accepts exact reference %j", (value) => {
		expect(schema.Check(value)).toBe(true);
		expect(isConfigReference(value)).toBe(true);
		expect(() => assertConfigValue(value, "fixture.key")).not.toThrow();
	});

	it.each([
		{},
		{ $file: "" },
		{ $env: "MY-TOKEN" },
		{ $file: "key", extra: true },
		{ $env: "TOKEN", $file: "key" },
		{ $concat: [{ $concat: ["nested"] }] },
		{ $concat: [1] },
	])("refuses malformed reference %j consistently", (value) => {
		expect(schema.Check(value)).toBe(false);
		expect(isConfigReference(value)).toBe(false);
		expect(() => assertConfigValue(value, "fixture.key")).toThrow(
			expect.objectContaining({ name: "ConfigReferenceError", field: "fixture.key", reason: "malformed" }),
		);
	});

	it("keeps legacy string acceptance separate from object recognition", () => {
		expect(schema.Check('{"$file":"key"}')).toBe(true);
		expect(isConfigReference('{"$file":"key"}')).toBe(false);
		expect(schema.Check("")).toBe(true);
		expect(Compile(NonemptyConfigValueSchema).Check("")).toBe(false);
	});
});
