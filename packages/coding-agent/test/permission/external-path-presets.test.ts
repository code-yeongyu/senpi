import { describe, expect, it } from "vitest";
import { rulesForPreset } from "../../src/core/extensions/builtin/permission-system/config.ts";
import { evaluate } from "../../src/core/extensions/builtin/permission-system/evaluate.ts";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";

describe("permission presets for external paths", () => {
	const cwd = "/Users/me/project";
	const registry = createBuiltinParserRegistry();

	it("asks for external paths from direct path-taking tools under workspace preset", () => {
		// given
		const cases = [
			{ toolName: "read", input: { path: "../secret.txt" } },
			{ toolName: "write", input: { path: "/tmp/outside.txt", content: "hello" } },
			{ toolName: "grep", input: { pattern: "token", path: "/tmp" } },
			{ toolName: "ls", input: { path: "/tmp", limit: 20 } },
		];
		const ruleset = rulesForPreset("workspace");

		for (const testCase of cases) {
			// when
			const requests = registry.parse(testCase.toolName, testCase.input, cwd);
			const externalRequest = requests.find((request) => request.permission === "external_directory");

			// then
			expect(externalRequest, testCase.toolName).toBeDefined();
			expect(evaluate("external_directory", externalRequest?.patterns[0] ?? "", ruleset).action).toBe("ask");
		}
	});

	it("does not broaden root-level external path approvals to the filesystem root", () => {
		// given
		const cases = [
			{ toolName: "ls", input: { path: "/tmp" }, always: ["/tmp/*"] },
			{ toolName: "read", input: { path: "/tmp/file.txt" }, always: ["/tmp/*"] },
			{ toolName: "read", input: { path: "/secret.txt" }, always: ["/secret.txt"] },
			{ toolName: "read", input: { path: "/secret" }, always: ["/secret"] },
		];

		for (const testCase of cases) {
			// when
			const requests = registry.parse(testCase.toolName, testCase.input, cwd);
			const externalRequest = requests.find((request) => request.permission === "external_directory");

			// then
			expect(externalRequest?.always, testCase.toolName).toEqual(testCase.always);
		}
	});
});
