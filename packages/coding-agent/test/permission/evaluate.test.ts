import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/core/extensions/builtin/permission-system/evaluate.js";
import type { Rule, Ruleset } from "../../src/core/extensions/builtin/permission-system/types.js";

function createRule(permission: string, pattern: string, action: Rule["action"]): Rule {
	return { permission, pattern, action };
}

describe("permission-system evaluate", () => {
	describe("single ruleset evaluation", () => {
		it("returns the matching rule from a single ruleset", () => {
			// given
			const rules: Ruleset = [createRule("read", "docs/*", "allow")];

			// when
			const result = evaluate("read", "docs/guide.md", rules);

			// then
			expect(result).toEqual(createRule("read", "docs/*", "allow"));
		});

		it("requires both permission and pattern to match", () => {
			// given
			const rules: Ruleset = [createRule("write", "*.ts", "deny")];

			// when
			const result = evaluate("read", "main.ts", rules);

			// then
			expect(result).toEqual({ action: "ask", permission: "read", pattern: "*" });
		});

		it("returns the last matching rule within one ruleset", () => {
			// given
			const rules: Ruleset = [createRule("read", "*", "deny"), createRule("read", "src/*", "allow")];

			// when
			const result = evaluate("read", "src/main.ts", rules);

			// then
			expect(result).toEqual(createRule("read", "src/*", "allow"));
		});

		it("returns ask when a single ruleset has no match", () => {
			// given
			const rules: Ruleset = [createRule("read", "docs/*", "allow")];

			// when
			const result = evaluate("read", "src/main.ts", rules);

			// then
			expect(result).toEqual({ action: "ask", permission: "read", pattern: "*" });
		});
	});

	describe("multiple rulesets", () => {
		it("searches across multiple rulesets in merge order", () => {
			// given
			const defaults: Ruleset = [createRule("*", "*", "deny")];
			const overrides: Ruleset = [createRule("read", "src/*", "allow")];

			// when
			const result = evaluate("read", "src/main.ts", defaults, overrides);

			// then
			expect(result).toEqual(createRule("read", "src/*", "allow"));
		});

		it("lets later rulesets override earlier ones when both match", () => {
			// given
			const defaults: Ruleset = [createRule("read", "src/*", "deny")];
			const overrides: Ruleset = [createRule("read", "src/*", "allow")];

			// when
			const result = evaluate("read", "src/main.ts", defaults, overrides);

			// then
			expect(result).toEqual(createRule("read", "src/*", "allow"));
		});

		it("keeps earlier ruleset result when later ruleset does not match", () => {
			// given
			const defaults: Ruleset = [createRule("read", "src/*", "allow")];
			const overrides: Ruleset = [createRule("write", "src/*", "deny")];

			// when
			const result = evaluate("read", "src/main.ts", defaults, overrides);

			// then
			expect(result).toEqual(createRule("read", "src/*", "allow"));
		});

		it("uses the last matching rule across three rulesets", () => {
			// given
			const defaults: Ruleset = [createRule("*", "*", "deny")];
			const workspace: Ruleset = [createRule("read", "src/*", "allow")];
			const session: Ruleset = [createRule("read", "src/private/*", "ask")];

			// when
			const result = evaluate("read", "src/private/secret.ts", defaults, workspace, session);

			// then
			expect(result).toEqual(createRule("read", "src/private/*", "ask"));
		});
	});

	describe("wildcards", () => {
		it("matches everything when both permission and pattern are wildcard", () => {
			// given
			const rules: Ruleset = [createRule("*", "*", "deny")];

			// when
			const result = evaluate("bash", "rm -rf /tmp/demo", rules);

			// then
			expect(result).toEqual(createRule("*", "*", "deny"));
		});

		it("matches any permission when rule permission is wildcard", () => {
			// given
			const rules: Ruleset = [createRule("*", "src/*", "ask")];

			// when
			const result = evaluate("edit", "src/main.ts", rules);

			// then
			expect(result).toEqual(createRule("*", "src/*", "ask"));
		});

		it("matches any pattern when rule pattern is wildcard", () => {
			// given
			const rules: Ruleset = [createRule("read", "*", "allow")];

			// when
			const result = evaluate("read", "any/arbitrary/path.txt", rules);

			// then
			expect(result).toEqual(createRule("read", "*", "allow"));
		});

		it("matches partial wildcard patterns", () => {
			// given
			const rules: Ruleset = [createRule("read", "*.env", "ask")];

			// when
			const result = evaluate("read", "secret.env", rules);

			// then
			expect(result).toEqual(createRule("read", "*.env", "ask"));
		});
	});

	describe("specific overrides and defaults", () => {
		it("lets a specific pattern override a wildcard from the same ruleset", () => {
			// given
			const rules: Ruleset = [createRule("read", "*", "deny"), createRule("read", "src/*", "allow")];

			// when
			const result = evaluate("read", "src/main.ts", rules);

			// then
			expect(result).toEqual(createRule("read", "src/*", "allow"));
		});

		it("lets a later wildcard override an earlier specific rule because last match wins", () => {
			// given
			const rules: Ruleset = [createRule("read", "src/*", "allow"), createRule("read", "*", "deny")];

			// when
			const result = evaluate("read", "src/main.ts", rules);

			// then
			expect(result).toEqual(createRule("read", "*", "deny"));
		});

		it("returns ask when no rulesets are provided", () => {
			// given
			const permission = "read";
			const pattern = "docs/readme.md";

			// when
			const result = evaluate(permission, pattern);

			// then
			expect(result).toEqual({ action: "ask", permission, pattern: "*" });
		});

		it("returns ask with the requested permission when rulesets do not match", () => {
			// given
			const rules: Ruleset = [createRule("write", "docs/*", "deny")];

			// when
			const result = evaluate("read", "docs/readme.md", rules);

			// then
			expect(result).toEqual({ action: "ask", permission: "read", pattern: "*" });
		});

		it("returns ask when only permission matches but pattern does not", () => {
			// given
			const rules: Ruleset = [createRule("read", "src/*", "allow")];

			// when
			const result = evaluate("read", "docs/readme.md", rules);

			// then
			expect(result).toEqual({ action: "ask", permission: "read", pattern: "*" });
		});
	});
});
