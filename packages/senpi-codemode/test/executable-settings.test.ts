import { describe, expect, it } from "vitest";
import { PROJECT_EXECUTABLE_SETTINGS } from "../src/config/project-trust.ts";
import { codemodeSettingsSchema } from "../src/config/settings.ts";

/**
 * Free-form string settings that do not name an executable. A new free-form string setting must be added here (with
 * why) or to the executable list; fixed-value strings (`const`) cannot name a path and are skipped.
 */
const NOT_EXECUTABLES = new Set([
	"taskTools.task", // a tool name
	"taskTools.output", // a tool name
	"environments.managedRoot", // a directory packages are installed into; nothing in it is run at session start
]);

function stringSettingPaths(schema: unknown, prefix = ""): string[] {
	if (typeof schema !== "object" || schema === null) return [];
	const type: unknown = Reflect.get(schema, "type");
	if (type === "string") return prefix === "" || Reflect.has(schema, "const") ? [] : [prefix];
	const properties: unknown = Reflect.get(schema, "properties");
	if (type !== "object" || typeof properties !== "object" || properties === null) return [];
	return Object.entries(properties).flatMap(([key, child]) =>
		stringSettingPaths(child, prefix === "" ? key : `${prefix}.${key}`),
	);
}

describe("Given the settings that name an executable run at session start", () => {
	it("When the settings schema has a string setting, then it is either on the executable list or known not to be one", () => {
		const unclassified = stringSettingPaths(codemodeSettingsSchema).filter(
			(path) => !PROJECT_EXECUTABLE_SETTINGS.includes(path) && !NOT_EXECUTABLES.has(path),
		);
		expect(unclassified).toEqual([]);
	});

	it("When the executable list names a setting, then the schema has that string setting", () => {
		const paths = stringSettingPaths(codemodeSettingsSchema);
		for (const path of PROJECT_EXECUTABLE_SETTINGS) expect(paths).toContain(path);
	});

	it("When pyInterpreter is checked, then it is on the executable list", () => {
		expect(PROJECT_EXECUTABLE_SETTINGS).toContain("languages.pyInterpreter");
	});
});
