import { describe, expect, it } from "vitest";
import { evaluate, fromConfig, merge } from "../../../src/core/extensions/builtin/agent-system/permission.js";
import type { PermissionConfig, Rule, Ruleset } from "../../../src/core/extensions/builtin/agent-system/types.js";

describe("Permission", () => {
	describe("evaluate", () => {
		it("returns last matching rule with findLast semantics", () => {
			// given
			const rules: Ruleset = [
				{ permission: "*", pattern: "*", action: "deny" },
				{ permission: "read", pattern: "*", action: "allow" },
			];

			// when
			const result = evaluate("read", "file.ts", rules);

			// then
			expect(result).toEqual({ permission: "read", pattern: "*", action: "allow" });
		});

		it("returns earlier match when later rule does not match", () => {
			// given
			const rules: Ruleset = [
				{ permission: "*", pattern: "*", action: "deny" },
				{ permission: "read", pattern: "*", action: "allow" },
			];

			// when
			const result = evaluate("write", "file.ts", rules);

			// then
			expect(result).toEqual({ permission: "*", pattern: "*", action: "deny" });
		});

		it("returns ask fallback when no rules are provided", () => {
			// given
			const rules: Ruleset = [];

			// when
			const result = evaluate("read", "*", rules);

			// then
			expect(result).toEqual({ action: "ask", permission: "read", pattern: "*" });
		});

		it("matches wildcard permission names", () => {
			// given
			const rules: Ruleset = [{ permission: "*", pattern: "*", action: "deny" }];

			// when
			const result = evaluate("read", "*", rules);

			// then
			expect(result).toEqual({ permission: "*", pattern: "*", action: "deny" });
		});

		it("matches wildcard patterns", () => {
			// given
			const rules: Ruleset = [{ permission: "read", pattern: "*.env", action: "ask" }];

			// when
			const result = evaluate("read", "secret.env", rules);

			// then
			expect(result).toEqual({ permission: "read", pattern: "*.env", action: "ask" });
		});

		it("returns ask fallback when pattern does not match", () => {
			// given
			const rules: Ruleset = [{ permission: "read", pattern: "*.env", action: "ask" }];

			// when
			const result = evaluate("read", "main.ts", rules);

			// then
			expect(result).toEqual({ action: "ask", permission: "read", pattern: "*" });
		});

		it("requires both permission and pattern to match", () => {
			// given
			const rules: Ruleset = [{ permission: "write", pattern: "*.ts", action: "deny" }];

			// when
			const result = evaluate("read", "main.ts", rules);

			// then
			expect(result).toEqual({ action: "ask", permission: "read", pattern: "*" });
		});

		it("searches across multiple rulesets", () => {
			// given
			const defaults: Ruleset = [{ permission: "*", pattern: "*", action: "deny" }];
			const overrides: Ruleset = [{ permission: "read", pattern: "src/*", action: "allow" }];

			// when
			const result = evaluate("read", "src/main.ts", defaults, overrides);

			// then
			expect(result).toEqual({ permission: "read", pattern: "src/*", action: "allow" });
		});

		it("prefers the last matching rule across multiple rulesets", () => {
			// given
			const defaults: Ruleset = [
				{ permission: "read", pattern: "*", action: "deny" },
				{ permission: "read", pattern: "src/*", action: "allow" },
			];
			const overrides: Ruleset = [{ permission: "read", pattern: "src/secrets/*", action: "ask" }];

			// when
			const result = evaluate("read", "src/secrets/.env", defaults, overrides);

			// then
			expect(result).toEqual({ permission: "read", pattern: "src/secrets/*", action: "ask" });
		});

		it("returns ask fallback with the requested permission when nothing matches", () => {
			// given
			const rules: Ruleset = [{ permission: "read", pattern: "docs/*", action: "allow" }];

			// when
			const result = evaluate("write", "docs/file.md", rules);

			// then
			expect(result).toEqual({ action: "ask", permission: "write", pattern: "*" });
		});
	});

	describe("fromConfig", () => {
		it("converts simple config entries into wildcard pattern rules", () => {
			// given
			const config: PermissionConfig = { bash: "allow" };

			// when
			const result = fromConfig(config);

			// then
			expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }]);
		});

		it("converts nested config entries into one rule per pattern", () => {
			// given
			const config: PermissionConfig = { read: { "*": "allow", "*.env": "ask" } };

			// when
			const result = fromConfig(config);

			// then
			expect(result).toEqual([
				{ permission: "read", pattern: "*", action: "allow" },
				{ permission: "read", pattern: "*.env", action: "ask" },
			]);
		});

		it("returns an empty ruleset for empty config", () => {
			// given
			const config: PermissionConfig = {};

			// when
			const result = fromConfig(config);

			// then
			expect(result).toEqual([]);
		});

		it("preserves object entry order for nested patterns", () => {
			// given
			const config: PermissionConfig = {
				read: {
					"*": "deny",
					"src/*": "allow",
					"src/secrets/*": "ask",
				},
			};

			// when
			const result = fromConfig(config);

			// then
			expect(result.map((rule) => rule.pattern)).toEqual(["*", "src/*", "src/secrets/*"]);
		});

		it("supports mixed simple and nested config entries", () => {
			// given
			const config: PermissionConfig = {
				bash: "deny",
				read: { "*": "allow", "*.env": "ask" },
			};

			// when
			const result = fromConfig(config);

			// then
			expect(result).toEqual([
				{ permission: "bash", pattern: "*", action: "deny" },
				{ permission: "read", pattern: "*", action: "allow" },
				{ permission: "read", pattern: "*.env", action: "ask" },
			]);
		});
	});

	describe("merge", () => {
		it("concatenates rulesets in order", () => {
			// given
			const defaults: Ruleset = [{ permission: "*", pattern: "*", action: "deny" }];
			const overrides: Ruleset = [{ permission: "read", pattern: "*", action: "allow" }];

			// when
			const result = merge(defaults, overrides);

			// then
			expect(result).toEqual([
				{ permission: "*", pattern: "*", action: "deny" },
				{ permission: "read", pattern: "*", action: "allow" },
			]);
		});

		it("returns an empty ruleset when merging nothing", () => {
			// given

			// when
			const result = merge();

			// then
			expect(result).toEqual([]);
		});

		it("allows later merged rules to win during evaluation", () => {
			// given
			const merged = merge(
				[{ permission: "read", pattern: "*", action: "deny" }],
				[{ permission: "read", pattern: "*", action: "allow" }],
			);

			// when
			const result = evaluate("read", "file.ts", merged);

			// then
			expect(result).toEqual({ permission: "read", pattern: "*", action: "allow" });
		});
	});

	describe("integration", () => {
		it("evaluates merged rules created from config", () => {
			// given
			const defaults = fromConfig({ read: { "*": "deny", "src/*": "allow" } });
			const overrides = fromConfig({ read: { "src/private/*": "ask" } });

			// when
			const result = evaluate("read", "src/private/key.ts", merge(defaults, overrides));

			// then
			expect(result).toEqual({ permission: "read", pattern: "src/private/*", action: "ask" });
		});

		it("returns concrete rule objects from matching configs", () => {
			// given
			const rules = fromConfig({ write: { "*.ts": "allow" } });

			// when
			const result = evaluate("write", "main.ts", rules);

			// then
			const expected: Rule = { permission: "write", pattern: "*.ts", action: "allow" };
			expect(result).toEqual(expected);
		});
	});
});
