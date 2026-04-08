import { describe, expect, it } from "vitest";
import { parsePermissionFlag } from "../../src/core/extensions/builtin/permission-system/cli.js";
import type { Rule } from "../../src/core/extensions/builtin/permission-system/types.js";

function createRule(permission: string, pattern: string, action: Rule["action"]): Rule {
	return { permission, pattern, action };
}

describe("permission-system cli", () => {
	describe("parsePermissionFlag", () => {
		it("parses simple tool=action format", () => {
			// given
			const value = "bash=allow";

			// when
			const result = parsePermissionFlag(value);

			// then
			expect(result).toEqual([createRule("bash", "*", "allow")]);
		});

		it("parses multiple rules separated by comma", () => {
			// given
			const value = "bash=allow,edit=deny";

			// when
			const result = parsePermissionFlag(value);

			// then
			expect(result).toEqual([createRule("bash", "*", "allow"), createRule("edit", "*", "deny")]);
		});

		it("parses tool:pattern=action format", () => {
			// given
			const value = "bash:git *=allow";

			// when
			const result = parsePermissionFlag(value);

			// then
			expect(result).toEqual([createRule("bash", "git *", "allow")]);
		});

		it("parses wildcard permission", () => {
			// given
			const value = "*=allow";

			// when
			const result = parsePermissionFlag(value);

			// then
			expect(result).toEqual([createRule("*", "*", "allow")]);
		});

		it("parses mixed formats", () => {
			// given
			const value = "bash=allow,edit:src/*=deny,write=ask";

			// when
			const result = parsePermissionFlag(value);

			// then
			expect(result).toEqual([
				createRule("bash", "*", "allow"),
				createRule("edit", "src/*", "deny"),
				createRule("write", "*", "ask"),
			]);
		});

		it("trims whitespace around entries", () => {
			// given
			const value = "bash = allow , edit = deny";

			// when
			const result = parsePermissionFlag(value);

			// then
			expect(result).toEqual([createRule("bash", "*", "allow"), createRule("edit", "*", "deny")]);
		});

		it("returns empty array for empty string", () => {
			// given
			const value = "";

			// when
			const result = parsePermissionFlag(value);

			// then
			expect(result).toEqual([]);
		});

		it("skips invalid entries", () => {
			// given
			const value = "bash=allow,invalid,edit=deny";

			// when
			const result = parsePermissionFlag(value);

			// then
			expect(result).toEqual([createRule("bash", "*", "allow"), createRule("edit", "*", "deny")]);
		});

		it("handles all action types", () => {
			// given
			const value = "bash=allow,edit=deny,write=ask";

			// when
			const result = parsePermissionFlag(value);

			// then
			expect(result).toEqual([
				createRule("bash", "*", "allow"),
				createRule("edit", "*", "deny"),
				createRule("write", "*", "ask"),
			]);
		});

		it("preserves pattern with spaces when using colon format", () => {
			// given
			const value = "bash:rm -rf *=deny";

			// when
			const result = parsePermissionFlag(value);

			// then
			expect(result).toEqual([createRule("bash", "rm -rf *", "deny")]);
		});
	});
});
