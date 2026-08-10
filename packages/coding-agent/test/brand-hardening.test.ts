import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BRAND_ENV_VAR, parseBrandProfile, resetBrandProfileForTests } from "../src/core/brand.ts";
import { getLatestPiRelease } from "../src/utils/version-check.ts";

describe("brand profile safety", () => {
	let stderr: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		stderr.mockRestore();
		delete process.env[BRAND_ENV_VAR];
		resetBrandProfileForTests();
	});

	test.each([
		["parent reference", ".."],
		["current directory", "."],
		["posix path", "../../etc"],
		["nested path", "omo/agent"],
		["windows path", "..\\omo"],
		["absolute path", "/tmp/omo"],
	])("rejects a profile whose configDir is a %s", (_label, configDir) => {
		expect(parseBrandProfile(JSON.stringify({ name: "omo", configDir }))).toBeUndefined();
	});

	test("accepts a plain directory name inside the home directory", () => {
		expect(parseBrandProfile('{"name":"omo","configDir":".omo"}')?.configDir).toBe(".omo");
	});
});

describe("branded update checks", () => {
	afterEach(() => {
		delete process.env[BRAND_ENV_VAR];
		resetBrandProfileForTests();
	});

	test("a brand without an update channel never advertises an engine release", async () => {
		process.env[BRAND_ENV_VAR] = '{"name":"omo","configDir":".omo"}';
		resetBrandProfileForTests();
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await expect(getLatestPiRelease("1.0.0")).resolves.toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();

		fetchSpy.mockRestore();
	});
});
