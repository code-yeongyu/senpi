import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

// senpi#2039: validate the configuration consumed by Vitest, not a second policy implementation.
describe("codemode CI worker policy", () => {
	it.each([
		{ flag: "CI", value: "1", maxWorkers: 2 },
		{ flag: "GITHUB_ACTIONS", value: "true", maxWorkers: 2 },
		{ flag: undefined, value: undefined, maxWorkers: null },
	])("uses the worker bound for $flag", async ({ flag, value, maxWorkers }) => {
		// Given: each config import runs in a fresh process with explicit CI provenance.
		const env = { ...process.env };
		delete env.CI;
		delete env.GITHUB_ACTIONS;
		if (flag !== undefined && value !== undefined) env[flag] = value;

		// When: the real config module is imported by the package's runtime.
		const { stdout } = await execute(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`import config from "./vitest.config.ts";
console.log(JSON.stringify({
	maxWorkers: config.test.maxWorkers ?? null,
	testTimeout: config.test.testTimeout
}));`,
			],
			{ cwd: new URL("..", import.meta.url), env, timeout: 10000 },
		);

		// Then: CI is bounded while local defaults and all assertion deadlines stay intact.
		expect(JSON.parse(stdout)).toEqual({ maxWorkers, testTimeout: 30000 });
	});
});
