import { describe, expect, test } from "vitest";
import { ENV_ENABLE_NEO, isNeoEnabled } from "../src/cli/neo/gate.ts";

/**
 * Pin the neo feature-gate contract. `isNeoEnabled` reads a single env var
 * (`ENV_ENABLE_NEO`), trims + lowercases it, and enables only for "1"/"true"/
 * "yes". Every case injects an explicit env object — the real `process.env` is
 * never mutated — so these rows fully define truthy set, case/whitespace
 * normalization, and default-false behavior. Any regression there reddens here.
 */
describe("isNeoEnabled — env gate contract", () => {
	test.each<[string, string]>([
		["exact 1", "1"],
		["exact true", "true"],
		["exact yes", "yes"],
		["uppercase TRUE", "TRUE"],
		["mixed-case Yes", "Yes"],
		["uppercase YES", "YES"],
		["padded 1", " 1 "],
		["padded true", "  true  "],
		["tab-wrapped yes", "\tyes\n"],
	])("enabled: %s -> true", (_label, value) => {
		expect(isNeoEnabled({ [ENV_ENABLE_NEO]: value })).toBe(true);
	});

	test.each<[string, NodeJS.ProcessEnv]>([
		["absent (empty env)", {}],
		["explicit undefined", { [ENV_ENABLE_NEO]: undefined }],
		["zero", { [ENV_ENABLE_NEO]: "0" }],
		["false", { [ENV_ENABLE_NEO]: "false" }],
		["no", { [ENV_ENABLE_NEO]: "no" }],
		["off", { [ENV_ENABLE_NEO]: "off" }],
		["empty string", { [ENV_ENABLE_NEO]: "" }],
		["whitespace only", { [ENV_ENABLE_NEO]: "   " }],
		["nope", { [ENV_ENABLE_NEO]: "nope" }],
		["two", { [ENV_ENABLE_NEO]: "2" }],
		["true with garbage suffix", { [ENV_ENABLE_NEO]: "true1" }],
		["truthy of another gate ignored", { SENPI_ENABLE_OTHER: "1" }],
	])("not enabled: %s -> false", (_label, env) => {
		expect(isNeoEnabled(env)).toBe(false);
	});

	test("defaults to process.env without mutating it, matching the documented rule", () => {
		const before = process.env[ENV_ENABLE_NEO];
		const raw = before;
		const expected = raw !== undefined && ["1", "true", "yes"].includes(raw.trim().toLowerCase());
		expect(isNeoEnabled()).toBe(expected);
		// The default-arg path must not set or delete the key.
		expect(process.env[ENV_ENABLE_NEO]).toBe(before);
	});
});
