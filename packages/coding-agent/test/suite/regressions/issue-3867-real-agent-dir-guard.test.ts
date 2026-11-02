import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { assertAgentDirAllowedInTests, getAgentDir, RealAgentDirInTestError } from "../../../src/config.ts";

// #3867: a run without the quarantine setup resolved the real agent dir and left faux pool state there.
// Every case below only resolves a path; nothing is written.

const realHome = userInfo().homedir;
const underTest = { SENPI_TEST_AGENT_DIR_GUARD: "1" };

describe("assertAgentDirAllowedInTests", () => {
	test.each([".senpi", ".omo", ".pi"])(
		"throws for the real home's %s agent dir in a guarded senpi test run",
		(brandDir) => {
			expect(() => assertAgentDirAllowedInTests(join(realHome, brandDir, "agent"), ".senpi", underTest)).toThrow(
				RealAgentDirInTestError,
			);
		},
	);

	test("throws for the active brand's flat config dir and anything below it", () => {
		expect(() => assertAgentDirAllowedInTests(join(realHome, ".acme"), ".acme", underTest)).toThrow(
			RealAgentDirInTestError,
		);
		expect(() => assertAgentDirAllowedInTests(join(realHome, ".acme", "nested"), ".acme", underTest)).toThrow(
			RealAgentDirInTestError,
		);
	});

	test("never fires for a user's own process that merely looks like a test run", () => {
		const real = join(realHome, ".senpi", "agent");
		expect(() => assertAgentDirAllowedInTests(real, ".senpi", { NODE_ENV: "test" })).not.toThrow();
		expect(() => assertAgentDirAllowedInTests(real, ".senpi", { VITEST: "true" })).not.toThrow();
	});

	test("allows temp dirs, look-alike siblings, the explicit opt-in, and non-test processes", () => {
		const real = join(realHome, ".omo", "agent");
		expect(() => assertAgentDirAllowedInTests(join(tmpdir(), "agent"), ".senpi", underTest)).not.toThrow();
		expect(() => assertAgentDirAllowedInTests(join(realHome, ".omo-backup"), ".senpi", underTest)).not.toThrow();
		expect(() =>
			assertAgentDirAllowedInTests(real, ".senpi", { ...underTest, SENPI_TEST_USE_REAL_AGENT_DIR: "1" }),
		).not.toThrow();
		expect(() => assertAgentDirAllowedInTests(real, ".senpi", {})).not.toThrow();
	});
});

describe("getAgentDir in a guarded senpi test run", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("throws instead of returning the real agent dir an inherited env points at", () => {
		vi.stubEnv("SENPI_TEST_AGENT_DIR_GUARD", "1");
		vi.stubEnv("SENPI_TEST_USE_REAL_AGENT_DIR", "");
		vi.stubEnv("SENPI_CODING_AGENT_DIR", join(realHome, ".omo", "agent"));

		expect(() => getAgentDir()).toThrow(RealAgentDirInTestError);
	});

	test("still returns a quarantined dir", () => {
		const quarantined = join(tmpdir(), "senpi-guard-quarantine", "agent");
		vi.stubEnv("SENPI_CODING_AGENT_DIR", quarantined);

		expect(getAgentDir()).toBe(quarantined);
	});
});
