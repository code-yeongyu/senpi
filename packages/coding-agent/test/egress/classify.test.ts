import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	classifyModelsJsonField,
	modelsJsonFieldClasses,
	MODELS_JSON_TYPE_ONLY_FIELDS,
} from "../../src/core/egress/classify.ts";
import { validateModelsConfig } from "../../src/core/model-config-schema.ts";
import { schemaFieldPaths } from "./schema-field-paths.ts";

const modelsJsonPaths = schemaFieldPaths(validateModelsConfig.Type());

describe("models.json field classification", () => {
	it("walks a schema that still has the fields this table was written against", () => {
		expect(modelsJsonPaths).toContain("providers.*.apiKey");
		expect(modelsJsonPaths).toContain("providers.*.models[].compat.thinkingFormat");
		expect(modelsJsonPaths.length).toBeGreaterThan(300);
	});

	it("classifies every field the models.json schema accepts", () => {
		const unclassified = modelsJsonPaths.filter((path) => classifyModelsJsonField(path) === undefined);
		expect(unclassified).toEqual([]);
	});

	it("has no entry for a field the schema no longer accepts", () => {
		const accepted = new Set(modelsJsonPaths);
		const stale = Object.keys(modelsJsonFieldClasses()).filter((path) => !accepted.has(path));
		expect(stale).toEqual([]);
		for (const path of Object.keys(MODELS_JSON_TYPE_ONLY_FIELDS)) expect(accepted.has(path)).toBe(false);
	});

	it.each([
		["providers.*.apiKey", "sealed"],
		["providers.*.headers.*", "sealed"],
		["providers.*.modelOverrides.*.headers.*", "sealed"],
		["providers.*.credentials.slots.*.value", "sealed"],
		["providers.*.credentials.slots.*.env", "device-only"],
		["providers.*.baseUrl", "endpoint"],
		["providers.*.headers.{key}", "public"],
		["providers.*.models[].headers.*", "sealed"],
		["providers.*.models[].baseUrl", "endpoint"],
		["providers.*.extraBody.*", "forces-device"],
		["providers.*.models[].extraBody.*", "forces-device"],
		["providers.*.modelOverrides.*.extraBody.*", "forces-device"],
	])("%s is %s", (path, expected) => {
		expect(classifyModelsJsonField(path)).toBe(expected);
	});
});

describe("models.json field classes built per call (r11.2 R8, option a)", () => {
	const oracle = JSON.parse(
		readFileSync(new URL("../fixtures/egress/models-json-field-classes-920a085089.json", import.meta.url), "utf8"),
	) as { fieldClasses: Record<string, string>; typeOnlyFields: Record<string, string> };

	it("equals the compact derivation shipped at 920a085089, entry for entry", () => {
		expect(Object.keys(oracle.fieldClasses)).toHaveLength(340);
		expect(Object.keys(oracle.typeOnlyFields)).toHaveLength(4);
		expect(modelsJsonFieldClasses()).toEqual(oracle.fieldClasses);
		expect(MODELS_JSON_TYPE_ONLY_FIELDS).toEqual(oracle.typeOnlyFields);
	});

	it("returns a fresh table on every call, so no caller can change another's", () => {
		const first = modelsJsonFieldClasses();
		expect(modelsJsonFieldClasses()).not.toBe(first);
		expect(modelsJsonFieldClasses()).toEqual(first);
	});
});
