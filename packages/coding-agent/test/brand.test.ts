import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	BRAND_ENV_VAR,
	brandEnvNames,
	consumeBrandProfile,
	envValue,
	parseBrandProfile,
	resetBrandProfileForTests,
	scrubBrandFromEnvironment,
} from "../src/core/brand.ts";

const OMO_PROFILE = JSON.stringify({
	name: "omo",
	displayVersion: "9.9.9",
	configDir: ".omo",
	flatLayout: true,
	envPrefix: "OMO",
	userAgent: "omo",
	originator: "omo",
});

describe("parseBrandProfile", () => {
	let stderr: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		stderr.mockRestore();
	});

	test("returns undefined when the variable is absent or empty", () => {
		expect(parseBrandProfile(undefined)).toBeUndefined();
		expect(parseBrandProfile("")).toBeUndefined();
		expect(parseBrandProfile("   ")).toBeUndefined();
		expect(stderr).not.toHaveBeenCalled();
	});

	test("reports and ignores malformed JSON instead of throwing", () => {
		expect(parseBrandProfile("{broken")).toBeUndefined();
		expect(stderr).toHaveBeenCalledOnce();
		expect(String(stderr.mock.calls[0]?.[0])).toContain(BRAND_ENV_VAR);
	});

	test("ignores JSON that is not an object, and objects without a name", () => {
		expect(parseBrandProfile('"omo"')).toBeUndefined();
		expect(parseBrandProfile("[1,2]")).toBeUndefined();
		expect(parseBrandProfile('{"displayVersion":"1.0.0"}')).toBeUndefined();
	});

	test("fills defaults from the name when optional fields are omitted", () => {
		const profile = parseBrandProfile('{"name":"omo"}');

		expect(profile).toEqual({
			name: "omo",
			displayVersion: undefined,
			configDir: ".omo",
			flatLayout: false,
			envPrefix: "OMO",
			userAgent: "omo",
			originator: undefined,
		});
	});

	test("keeps every field of a complete profile", () => {
		expect(parseBrandProfile(OMO_PROFILE)).toEqual({
			name: "omo",
			displayVersion: "9.9.9",
			configDir: ".omo",
			flatLayout: true,
			envPrefix: "OMO",
			userAgent: "omo",
			originator: "omo",
		});
	});
});

describe("consumeBrandProfile", () => {
	test("reads the profile without disturbing the environment", () => {
		const env: NodeJS.ProcessEnv = { [BRAND_ENV_VAR]: OMO_PROFILE, PATH: "/usr/bin" };

		const profile = consumeBrandProfile(env);

		expect(profile?.name).toBe("omo");
		expect(env.PATH).toBe("/usr/bin");
	});

	test("keeps the variable readable for the process the entrypoint re-spawns", () => {
		// The CLI entrypoint resolves the brand and then hands process.env to a child that runs
		// the agent; scrubbing here would leave that child unbranded.
		const env: NodeJS.ProcessEnv = { [BRAND_ENV_VAR]: OMO_PROFILE };

		consumeBrandProfile(env);

		expect(env[BRAND_ENV_VAR]).toBe(OMO_PROFILE);
	});
});

describe("scrubBrandFromEnvironment", () => {
	test("removes the variable so a nested engine run keeps the engine identity", () => {
		const env: NodeJS.ProcessEnv = { [BRAND_ENV_VAR]: OMO_PROFILE, PATH: "/usr/bin" };

		scrubBrandFromEnvironment(env);

		expect(BRAND_ENV_VAR in env).toBe(false);
		expect(env.PATH).toBe("/usr/bin");
	});

	test("the entrypoints that run the agent scrub after resolving the brand", () => {
		for (const entry of ["cli-main.ts", "rpc-entry.ts"]) {
			const source = readFileSync(new URL(`../src/${entry}`, import.meta.url), "utf-8");

			expect(source).toContain("scrubBrandFromEnvironment()");
		}
	});
});

describe("config module brand integration", () => {
	const savedBrand = process.env[BRAND_ENV_VAR];

	afterEach(() => {
		if (savedBrand === undefined) delete process.env[BRAND_ENV_VAR];
		else process.env[BRAND_ENV_VAR] = savedBrand;
		vi.resetModules();
	});

	test("standalone install keeps the engine identity", async () => {
		delete process.env[BRAND_ENV_VAR];
		vi.resetModules();

		const config = await import("../src/config.ts");

		expect(config.APP_NAME).toBe("senpi");
		expect(config.CONFIG_DIR_NAME).toBe(".senpi");
		expect(config.CONFIG_FLAT_LAYOUT).toBe(false);
		expect(config.DISPLAY_VERSION).toBe(config.VERSION);
		expect(config.ENV_AGENT_DIR).toBe("SENPI_CODING_AGENT_DIR");
	});

	test("branded install renames the product", async () => {
		process.env[BRAND_ENV_VAR] = OMO_PROFILE;
		vi.resetModules();

		const config = await import("../src/config.ts");

		expect(config.APP_NAME).toBe("omo");
		expect(config.APP_TITLE).toBe("omo");
		expect(config.CONFIG_DIR_NAME).toBe(".omo");
		expect(config.CONFIG_FLAT_LAYOUT).toBe(true);
		expect(config.DISPLAY_VERSION).toBe("9.9.9");
		expect(config.ENV_AGENT_DIR).toBe("OMO_CODING_AGENT_DIR");
		// Resolution alone must not scrub: the entrypoint re-spawns the agent with this env.
		expect(process.env[BRAND_ENV_VAR]).toBe(OMO_PROFILE);
	});
});

describe("envValue", () => {
	afterEach(() => {
		resetBrandProfileForTests();
		delete process.env[BRAND_ENV_VAR];
	});

	test("prefers the brand prefix, then the legacy prefixes, in order", () => {
		process.env[BRAND_ENV_VAR] = OMO_PROFILE;
		resetBrandProfileForTests();

		const env = { OMO_OFFLINE: "brand", SENPI_OFFLINE: "engine", PI_OFFLINE: "legacy" };

		expect(envValue("OFFLINE", env)).toBe("brand");
		expect(envValue("OFFLINE", { SENPI_OFFLINE: "engine", PI_OFFLINE: "legacy" })).toBe("engine");
		expect(envValue("OFFLINE", { PI_OFFLINE: "legacy" })).toBe("legacy");
		expect(envValue("OFFLINE", {})).toBeUndefined();
	});

	test("returns an explicitly empty value, so `set but empty` keeps its meaning", () => {
		expect(envValue("OFFLINE", { PI_OFFLINE: "" })).toBe("");
	});

	test("a standalone install reads only the engine and legacy names", () => {
		resetBrandProfileForTests();

		expect(brandEnvNames("CODING_AGENT_DIR")).toEqual(["SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]);
	});

	test("a branded install reads its own name first and never duplicates a prefix", () => {
		process.env[BRAND_ENV_VAR] = OMO_PROFILE;
		resetBrandProfileForTests();

		expect(brandEnvNames("CODING_AGENT_DIR")).toEqual([
			"OMO_CODING_AGENT_DIR",
			"SENPI_CODING_AGENT_DIR",
			"PI_CODING_AGENT_DIR",
		]);
	});
});
