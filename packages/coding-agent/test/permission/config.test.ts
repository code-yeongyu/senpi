import os from "node:os";
import { describe, expect, it } from "vitest";
import {
	disabled,
	EDIT_TOOLS,
	expand,
	fromConfig,
	merge,
} from "../../src/core/extensions/builtin/permission-system/config.js";
import type { PermissionConfig, Ruleset } from "../../src/core/extensions/builtin/permission-system/types.js";

describe("permission config transforms", () => {
	describe("EDIT_TOOLS", () => {
		it("contains the expected edit-related tools", () => {
			// then
			expect(EDIT_TOOLS).toEqual(["edit", "write", "apply_patch", "multiedit"]);
		});
	});

	describe("expand", () => {
		it("expands ~/ to os.homedir()", () => {
			// given
			const home = os.homedir();

			// when
			const result = expand("~/projects/foo");

			// then
			expect(result).toBe(`${home}/projects/foo`);
		});

		it("expands ~ to os.homedir()", () => {
			// given
			const home = os.homedir();

			// when
			const result = expand("~");

			// then
			expect(result).toBe(home);
		});

		it("expands $HOME/ to os.homedir()", () => {
			// given
			const home = os.homedir();

			// when
			const result = expand("$HOME/projects/foo");

			// then
			expect(result).toBe(`${home}/projects/foo`);
		});

		it("expands $HOME to os.homedir()", () => {
			// given
			const home = os.homedir();

			// when
			const result = expand("$HOME");

			// then
			expect(result).toBe(home);
		});

		it("returns non-home paths unchanged", () => {
			// given
			const path = "/usr/local/bin";

			// when
			const result = expand(path);

			// then
			expect(result).toBe(path);
		});

		it("returns relative paths unchanged", () => {
			// given
			const path = "./src/index.ts";

			// when
			const result = expand(path);

			// then
			expect(result).toBe(path);
		});
	});

	describe("fromConfig", () => {
		it("converts flat string values to wildcard patterns", () => {
			// given
			const config: PermissionConfig = {
				read: "allow",
				write: "deny",
			};

			// when
			const result = fromConfig(config);

			// then
			expect(result).toEqual([
				{ permission: "read", pattern: "*", action: "allow" },
				{ permission: "write", pattern: "*", action: "deny" },
			]);
		});

		it("converts nested config to multiple rules", () => {
			// given
			const home = os.homedir();
			const config: PermissionConfig = {
				read: {
					"*.md": "allow",
					"*.txt": "ask",
				},
				write: {
					"~/projects/*": "allow",
					"/etc/*": "deny",
				},
			};

			// when
			const result = fromConfig(config);

			// then
			expect(result).toEqual([
				{ permission: "read", pattern: "*.md", action: "allow" },
				{ permission: "read", pattern: "*.txt", action: "ask" },
				{ permission: "write", pattern: `${home}/projects/*`, action: "allow" },
				{ permission: "write", pattern: "/etc/*", action: "deny" },
			]);
		});

		it("expands paths with ~/ in nested config", () => {
			// given
			const home = os.homedir();
			const config: PermissionConfig = {
				write: {
					"~/projects/*": "allow",
				},
			};

			// when
			const result = fromConfig(config);

			// then
			expect(result).toEqual([{ permission: "write", pattern: `${home}/projects/*`, action: "allow" }]);
		});

		it("expands paths with $HOME/ in nested config", () => {
			// given
			const home = os.homedir();
			const config: PermissionConfig = {
				read: {
					"$HOME/.config/*": "allow",
				},
			};

			// when
			const result = fromConfig(config);

			// then
			expect(result).toEqual([{ permission: "read", pattern: `${home}/.config/*`, action: "allow" }]);
		});

		it("handles mixed flat and nested values", () => {
			// given
			const home = os.homedir();
			const config: PermissionConfig = {
				read: "allow",
				write: {
					"~/projects/*": "ask",
				},
			};

			// when
			const result = fromConfig(config);

			// then
			expect(result).toEqual([
				{ permission: "read", pattern: "*", action: "allow" },
				{ permission: "write", pattern: `${home}/projects/*`, action: "ask" },
			]);
		});

		it("returns empty array for empty config", () => {
			// given
			const config: PermissionConfig = {};

			// when
			const result = fromConfig(config);

			// then
			expect(result).toEqual([]);
		});
	});

	describe("merge", () => {
		it("concatenates multiple rulesets into one", () => {
			// given
			const ruleset1: Ruleset = [{ permission: "read", pattern: "*", action: "allow" }];
			const ruleset2: Ruleset = [{ permission: "write", pattern: "*", action: "ask" }];

			// when
			const result = merge(ruleset1, ruleset2);

			// then
			expect(result).toEqual([
				{ permission: "read", pattern: "*", action: "allow" },
				{ permission: "write", pattern: "*", action: "ask" },
			]);
		});

		it("returns empty array when no rulesets provided", () => {
			// when
			const result = merge();

			// then
			expect(result).toEqual([]);
		});

		it("flattens single ruleset correctly", () => {
			// given
			const ruleset: Ruleset = [{ permission: "read", pattern: "*", action: "allow" }];

			// when
			const result = merge(ruleset);

			// then
			expect(result).toEqual([{ permission: "read", pattern: "*", action: "allow" }]);
		});

		it("preserves order of rules from multiple rulesets", () => {
			// given
			const ruleset1: Ruleset = [
				{ permission: "read", pattern: "*.ts", action: "allow" },
				{ permission: "read", pattern: "*.js", action: "ask" },
			];
			const ruleset2: Ruleset = [{ permission: "write", pattern: "*.ts", action: "deny" }];
			const ruleset3: Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }];

			// when
			const result = merge(ruleset1, ruleset2, ruleset3);

			// then
			expect(result).toEqual([
				{ permission: "read", pattern: "*.ts", action: "allow" },
				{ permission: "read", pattern: "*.js", action: "ask" },
				{ permission: "write", pattern: "*.ts", action: "deny" },
				{ permission: "bash", pattern: "*", action: "ask" },
			]);
		});
	});

	describe("disabled", () => {
		it("returns empty set when no deny-all rules exist", () => {
			// given
			const tools = ["read", "write", "edit"];
			const ruleset: Ruleset = [
				{ permission: "read", pattern: "*", action: "allow" },
				{ permission: "write", pattern: "*", action: "ask" },
			];

			// when
			const result = disabled(tools, ruleset);

			// then
			expect(result).toEqual(new Set());
		});

		it("identifies tools with deny-all rules", () => {
			// given
			const tools = ["read", "bash", "grep"];
			const ruleset: Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }];

			// when
			const result = disabled(tools, ruleset);

			// then
			expect(result).toEqual(new Set(["bash"]));
		});

		it("maps EDIT_TOOLS to edit permission key", () => {
			// given
			const tools = ["edit", "write", "apply_patch", "multiedit", "read"];
			const ruleset: Ruleset = [{ permission: "edit", pattern: "*", action: "deny" }];

			// when
			const result = disabled(tools, ruleset);

			// then
			expect(result).toEqual(new Set(["edit", "write", "apply_patch", "multiedit"]));
		});

		it("only includes tools that are in the input tools list", () => {
			// given
			const tools = ["write", "read"];
			const ruleset: Ruleset = [{ permission: "edit", pattern: "*", action: "deny" }];

			// when
			const result = disabled(tools, ruleset);

			// then
			expect(result).toEqual(new Set(["write"]));
		});

		it("returns empty set when ruleset is empty", () => {
			// given
			const tools = ["read", "write"];
			const ruleset: Ruleset = [];

			// when
			const result = disabled(tools, ruleset);

			// then
			expect(result).toEqual(new Set());
		});

		it("handles partial matches via wildcards", () => {
			// given
			const tools = ["read_file", "write_file", "edit_file"];
			const ruleset: Ruleset = [{ permission: "*write*", pattern: "*", action: "deny" }];

			// when
			const result = disabled(tools, ruleset);

			// then
			expect(result).toEqual(new Set(["write_file"]));
		});

		it("ignores non-deny actions", () => {
			// given
			const tools = ["read", "write"];
			const ruleset: Ruleset = [
				{ permission: "write", pattern: "*", action: "allow" },
				{ permission: "read", pattern: "*", action: "ask" },
			];

			// when
			const result = disabled(tools, ruleset);

			// then
			expect(result).toEqual(new Set());
		});

		it("ignores non-wildcard patterns even with deny action", () => {
			// given
			const tools = ["read", "write"];
			const ruleset: Ruleset = [{ permission: "write", pattern: "*.txt", action: "deny" }];

			// when
			const result = disabled(tools, ruleset);

			// then
			expect(result).toEqual(new Set());
		});
	});
});
