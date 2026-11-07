import { describe, expect, it } from "vitest";
import {
	classifyModelsJsonField,
	MODELS_JSON_FIELD_CLASSES,
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
		const stale = Object.keys(MODELS_JSON_FIELD_CLASSES).filter((path) => !accepted.has(path));
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
