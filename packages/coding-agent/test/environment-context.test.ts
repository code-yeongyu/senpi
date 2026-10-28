import { describe, expect, test, vi } from "vitest";
import { resolveEnvironmentContext } from "../src/core/environment-context.ts";

// senpi#4660: SENPI_TEST_CURRENT_DATE pins the environment context's date so a harness driving the real CLI
// gets the same prompt bytes on every day; unset keeps the date from the clock.

const LATE_UTC = new Date("2026-09-24T23:59:59.000Z");

describe("resolveEnvironmentContext date", () => {
	test("unset: the UTC calendar date of now", () => {
		vi.stubEnv("SENPI_TEST_CURRENT_DATE", undefined);

		expect(resolveEnvironmentContext("C:\\work\\repo", LATE_UTC)).toEqual({
			cwd: "C:/work/repo",
			currentDate: "2026-09-24",
		});
	});

	test("empty counts as unset", () => {
		vi.stubEnv("SENPI_TEST_CURRENT_DATE", "");

		expect(resolveEnvironmentContext("/repo", LATE_UTC).currentDate).toBe("2026-09-24");
	});

	test("set: the pinned date, whatever the clock says", () => {
		vi.stubEnv("SENPI_TEST_CURRENT_DATE", "2030-01-02");

		expect(resolveEnvironmentContext("/repo", LATE_UTC)).toEqual({ cwd: "/repo", currentDate: "2030-01-02" });
		expect(resolveEnvironmentContext("/repo").currentDate).toBe("2030-01-02");
	});

	test.each([
		"2030-1-2",
		"2030-02-30",
		"2030-13-01",
		"2030-00-10",
		"2030-01-32",
		"tomorrow",
		" 2030-01-02",
		"2030-01-02T00:00:00Z",
	])("malformed %j throws naming the variable", (value) => {
		vi.stubEnv("SENPI_TEST_CURRENT_DATE", value);

		expect(() => resolveEnvironmentContext("/repo", LATE_UTC)).toThrow(/SENPI_TEST_CURRENT_DATE/);
	});
});
